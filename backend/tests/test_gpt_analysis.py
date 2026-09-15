import json
from types import SimpleNamespace
import pytest
from backend.app.database import Database
from backend.app.repository import StoryRepository
from backend.app.pipeline.gpt_analyzer import GptStoryAnalyzer, parse_review_result


def fixture(tmp_path):
    repo = StoryRepository(Database(tmp_path / 'test.sqlite'))
    project = repo.create_project('검증')
    doc = repo.add_document(project.id, tmp_path / 'story.txt', '원고', 'txt', 'hash', '계약자만 검을 쓴다. 유나는 계약 없이 검을 쓴다.', 0)
    ids = repo.replace_chunks(project.id, doc.id, ['계약자만 검을 쓴다.', '유나는 계약 없이 검을 쓴다.'])
    rag = SimpleNamespace(sync_project=lambda _: 2, retrieve=lambda *a, **k: [{'chunk_id': i, 'text': text} for i, text in zip(ids, ['계약자만 검을 쓴다.', '유나는 계약 없이 검을 쓴다.'])])
    return repo, project, ids, rag


def test_parse_review_result_normalizes_numeric_evidence_ids():
    result = parse_review_result(json.dumps({
        'entities': [{'id': 'e1', 'type': 'character', 'name': '유나', 'summary': '주인공',
                      'evidence': [{'chunk_id': '42', 'quote': '유나가 말했다.'}]}],
        'relations': [],
        'issues': [{'title': '후보', 'description': '확인 필요', 'severity': 'low',
                    'evidence_chunk_ids': ['42', 43]}],
    }))
    assert result.entities[0].evidence[0].chunk_id == 42
    assert result.issues[0].evidence_chunk_ids == [42, 43]


def test_parse_review_result_drops_ungrounded_entities_and_their_relations():
    # Observed with gpt-5.6-luna: one minor entity arrives with `evidence: []`
    # and used to fail the whole review window on min_length=1.
    result = parse_review_result(json.dumps({
        'entities': [
            {'id': 'a', 'type': 'character', 'name': '유나', 'summary': '주인공',
             'evidence': [{'chunk_id': 1, 'quote': '유나가 말했다.'}]},
            {'id': 'b', 'type': 'place', 'name': '회백원', 'summary': '근거 없음', 'evidence': []},
            {'id': 'c', 'type': 'item', 'name': '봉인검', 'summary': '검',
             'evidence': [{'chunk_id': 2, 'quote': '봉인검을 들어 올렸다.'}]},
        ],
        'relations': [
            {'source': 'a', 'target': 'b', 'type': '방문', 'explanation': '유나가 회백원에 갔다.', 'basis': 'explicit',
             'evidence': [{'chunk_id': 1, 'quote': '유나가 말했다.'}]},
            {'source': 'a', 'target': 'c', 'type': '사용', 'explanation': '유나가 봉인검을 사용했다.', 'basis': 'explicit',
             'evidence': [{'chunk_id': 2, 'quote': '봉인검을 들어 올렸다.'}]},
            {'source': 'c', 'target': 'a', 'type': '소유', 'explanation': '근거 없는 관계입니다.', 'basis': 'inferred',
             'evidence': []},
        ],
        'issues': [],
    }))
    assert [entity.id for entity in result.entities] == ['a', 'c']
    assert [(relation.source, relation.target) for relation in result.relations] == [('a', 'c')]


def test_gpt_analysis_persists_only_grounded_candidates(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    calls = []
    def complete(model, prompt, **kwargs):
        calls.append(prompt)
        assert kwargs['effort'] == 'low'
        assert str(ids[0]) in prompt and '계약자만' in prompt
        return {'text': json.dumps({'entities': [], 'relations': [], 'issues': [{'title': '계약 조건 충돌 후보', 'description': '검 사용 조건과 행동이 다릅니다.', 'severity': 'high', 'evidence_chunk_ids': ids}]})}
    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'model', 'low')
    assert len(calls) == 2
    assert result['issue_count'] == 1
    assert repo.graph(project.id).issues[0].evidence_chunk_ids == ids
    assert repo.latest_analysis_job(project.id).status.value == 'completed'


def test_gpt_review_reuses_prepared_index_for_each_window(tmp_path):
    repo, project, ids, _ = fixture(tmp_path)
    retrieval_kwargs = []

    def retrieve(*args, **kwargs):
        retrieval_kwargs.append(kwargs)
        return []

    rag = SimpleNamespace(sync_project=lambda _: len(ids), retrieve=retrieve)
    connection = SimpleNamespace(complete=lambda *args, **kwargs: {
        'text': '{"entities": [], "relations": [], "issues": []}'
    })
    GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', 'low')
    assert retrieval_kwargs
    assert all(kwargs.get('ensure_index') is False for kwargs in retrieval_kwargs)


def test_gpt_index_progress_reports_chunk_eta(tmp_path):
    repo, project, ids, _ = fixture(tmp_path)
    progress_messages = []

    def sync_project(project_id, progress=None):
        assert project_id == project.id
        progress(1, 4)
        progress(4, 4)
        return 2

    rag = SimpleNamespace(repository=repo, sync_project=sync_project, retrieve=lambda *a, **k: [])
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': '{"entities": [], "relations": [], "issues": []}'})
    original_update = repo.update_running_job

    def capture_update(*args, **kwargs):
        if kwargs.get('current_step') == 'gpt_index':
            progress_messages.append(args[2])
        return original_update(*args, **kwargs)

    repo.update_running_job = capture_update
    GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', 'low')
    assert any('1/4개 청크' in message and '남음' in message for message in progress_messages)


def test_cancellation_during_index_stops_at_next_batch(tmp_path):
    repo, project, ids, _ = fixture(tmp_path)

    def sync_project(project_id, progress=None):
        assert project_id == project.id
        repo.cancel_analysis(project.id, preserve_results=True)
        progress(1, 100)

    rag = SimpleNamespace(sync_project=sync_project, retrieve=lambda *a, **k: [])
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': '{"entities": [], "relations": [], "issues": []}'})
    with pytest.raises(RuntimeError, match='취소'):
        GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', 'low')
    assert repo.latest_analysis_job(project.id).status.value == 'cancelled'


def test_gpt_window_failure_isolated_and_retryable(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    calls = []

    def complete(model, prompt, **kwargs):
        calls.append(prompt)
        if len(calls) == 1:
            raise RuntimeError('모델 응답이 거부되었습니다')
        return {'text': '{"entities": [], "relations": [], "issues": []}'}

    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'model', 'low')
    assert result['failed_window_count'] == 1
    assert result['failed_windows'][0]['index'] == 1
    assert result['failed_windows'][0]['attempts'] == 1
    assert result['failed_windows'][0]['stage']
    assert repo.latest_analysis_job(project.id).status.value == 'partial'
    assert '기존 결과' in repo.latest_analysis_job(project.id).message


def test_batch_limit_persists_completed_windows_and_resumes_remaining(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    calls = []

    def complete(model, prompt, **kwargs):
        calls.append(prompt)
        return {'text': '{"entities": [], "relations": [], "issues": []}'}

    analyzer = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete))
    first = analyzer.analyze(project.id, 'model', 'low', batch_limit=1)
    assert first['published'] is False
    assert first['batch_limited'] is True
    assert len(calls) == 1
    assert repo.latest_analysis_job(project.id).status.value == 'partial'
    assert '나머지를 이어갑니다' in repo.latest_analysis_job(project.id).message
    second = analyzer.analyze(project.id, 'model', 'low', batch_limit=1)
    assert second['published'] is True
    assert second['batch_limited'] is False
    assert len(calls) == 2
    assert second['cached_count'] == 1


def test_chapter_range_limits_review_windows_without_dropping_unselected_data(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    rag = SimpleNamespace(sync_project=lambda _: 3, retrieve=lambda *a, **k: [])
    second = repo.add_document(project.id, tmp_path / 'story-02.txt', '원고 2', 'txt', 'hash-2', '두 번째 회차의 새로운 사건.', 1)
    second_ids = repo.replace_chunks(project.id, second.id, ['두 번째 회차의 새로운 사건.'])
    prompts = []

    def complete(model, prompt, **kwargs):
        prompts.append(prompt)
        return {'text': '{"entities": [], "relations": [], "issues": []}'}

    analyzer = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete))
    result = analyzer.analyze(project.id, 'model', 'low', start_chapter=1, end_chapter=1)
    assert result['published'] is True
    assert repo.latest_analysis_job(project.id).review_context['start_chapter'] == 1
    assert repo.latest_analysis_job(project.id).review_context['end_chapter'] == 1
    assert len(prompts) == 1
    assert str(second_ids[0]) in prompts[0]
    assert str(ids[0]) not in prompts[0]


def test_chapter_range_reanalysis_preserves_graph_from_unselected_chapters(tmp_path):
    repo = StoryRepository(Database(tmp_path / 'range-preserve.sqlite'))
    project = repo.create_project('범위 병합')
    first = repo.add_document(project.id, tmp_path / 'first.txt', '1화', 'txt', 'first', '유나는 봉인검을 지켰다.', 0)
    second = repo.add_document(project.id, tmp_path / 'second.txt', '2화', 'txt', 'second', '도윤은 항구를 떠났다.', 1)
    first_ids = repo.replace_chunks(project.id, first.id, [first.content])
    repo.replace_chunks(project.id, second.id, [second.content])
    rag = SimpleNamespace(sync_project=lambda _: 2, retrieve=lambda *a, **k: [])
    first_response = json.dumps({'entities': [
        {'id': 'yuna', 'type': 'character', 'name': '유나', 'summary': '검을 지키는 인물',
         'evidence': [{'chunk_id': first_ids[0], 'quote': first.content}]},
        {'id': 'sword', 'type': 'item', 'name': '봉인검', 'summary': '유나가 지키는 검',
         'evidence': [{'chunk_id': first_ids[0], 'quote': first.content}]},
    ], 'relations': [{
        'source': 'yuna', 'target': 'sword', 'type': '지킴', 'explanation': '유나가 봉인검을 지킨다.', 'basis': 'explicit',
        'evidence': [{'chunk_id': first_ids[0], 'quote': first.content}],
    }], 'issues': []})
    responses = iter([{'text': first_response}, {'text': '{"entities": [], "relations": [], "issues": []}'},
                      {'text': '{"entities": [], "relations": [], "issues": []}'}])
    connection = SimpleNamespace(complete=lambda *a, **k: next(responses))
    analyzer = GptStoryAnalyzer(repo, rag, connection)
    analyzer.analyze(project.id, 'model', 'low', force=True)
    analyzer.analyze(project.id, 'model', 'low', force=True, start_chapter=1, end_chapter=1)
    graph = repo.graph(project.id)
    assert any(relation.type == '지킴' for relation in graph.relations)
    assert any(entity.name == '유나' for entity in graph.entities)

def test_large_manuscript_advances_in_twenty_window_batches(tmp_path):
    repo = StoryRepository(Database(tmp_path / 'large-batches.sqlite'))
    project = repo.create_project('45회 장편 배치')
    for index in range(45):
        text = f'{index + 1}화. 유나는 항구의 기록을 확인했다. ' + ('바람이 불었다. ' * 250)
        document = repo.add_document(project.id, tmp_path / f'{index}.txt', f'{index + 1}화', 'txt', str(index), text, index)
        repo.replace_chunks(project.id, document.id, [text])
    rag = SimpleNamespace(sync_project=lambda _: 45, retrieve=lambda *args, **kwargs: [])
    calls = []

    def complete(model, prompt, **kwargs):
        calls.append(prompt)
        return {'text': '{"entities": [], "relations": [], "issues": []}'}

    analyzer = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete))
    first = analyzer.analyze(project.id, 'model', 'low', batch_limit=20)
    second = analyzer.analyze(project.id, 'model', 'low', batch_limit=20)
    third = analyzer.analyze(project.id, 'model', 'low', batch_limit=20)
    assert [result['batch_limited'] for result in (first, second, third)] == [True, True, False]
    assert [result['published'] for result in (first, second, third)] == [False, False, True]
    assert [len(calls)] == [45]
    assert second['cached_count'] == 20
    assert third['cached_count'] == 40


def test_partial_review_preserves_published_results_and_resumes_after_restart(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    old = repo.add_issue(project.id, 'low', 'contradiction', '이전 결과', '보존', ids)
    node = repo.upsert_entity(project.id, 'character', '기존 인물', [], '보존', None)
    calls = []

    def complete(model, prompt, **kwargs):
        calls.append(prompt)
        if len(calls) == 1:
            raise RuntimeError('모델 응답이 거부되었습니다')
        # The failure must already be durable while the next window is running.
        details = repo.latest_analysis_job(project.id).window_details
        assert details[0]['status'] == 'failed'
        assert '모델 응답이 거부되었습니다' in details[0]['error']
        return {'text': json.dumps(graph_payload(ids))}

    GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'model', 'medium', force=True)
    assert repo.graph(project.id).issues[0].id == old.id
    assert repo.graph(project.id).entities[0].id == node.id
    retry_calls = []
    def retry(*args, **kwargs):
        retry_calls.append(args)
        return {'text': json.dumps(graph_payload(ids))}
    restarted_repo = StoryRepository(Database(tmp_path / 'test.sqlite'))
    result = GptStoryAnalyzer(restarted_repo, rag, SimpleNamespace(complete=retry)).analyze(project.id, 'model', 'medium')
    assert len(retry_calls) == 1
    assert result['cached_count'] == 1
    assert restarted_repo.latest_analysis_job(project.id).status.value == 'completed'
    assert {node.name for node in restarted_repo.graph(project.id).entities} == {'유나', '검'}


def test_retrieval_failure_isolated_before_any_gpt_request(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    retrieve = rag.retrieve
    count = 0
    def broken(*args, **kwargs):
        nonlocal count
        count += 1
        if count == 1:
            raise RuntimeError('로컬 검색 실패')
        return retrieve(*args, **kwargs)
    rag.retrieve = broken
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': '{"entities":[],"relations":[],"issues":[]}'})
    result = GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', 'medium')
    assert result['failed_window_count'] == 1
    details = repo.latest_analysis_job(project.id).window_details
    assert details[0]['stage'] == 'retrieve'
    assert details[0]['attempts'] == 0
    assert details[1]['status'] == 'completed'


def test_ten_windows_backoff_isolation_and_only_failed_window_retry(tmp_path, monkeypatch):
    import backend.app.pipeline.gpt_analyzer as module
    clock = [0.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(module.time, 'sleep', lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    repo = StoryRepository(Database(tmp_path / 'ten.sqlite'))
    project = repo.create_project('열 회차 복구 검사')
    for index in range(10):
        text = f'{index + 1}화. 유나는 항구의 기록을 확인했다.'
        doc = repo.add_document(project.id, tmp_path / f'{index}.txt', f'기록 {index + 1}', 'txt', str(index), text, index)
        repo.replace_chunks(project.id, doc.id, [text])
    rows = repo.list_chunks(project.id)
    rag = SimpleNamespace(sync_project=lambda _: 10, retrieve=lambda *a, **k: [])
    calls = []
    def connection(*args, **kwargs):
        calls.append(args)
        job = repo.latest_analysis_job(project.id)
        active = next(window for window in job.window_details if window['status'] == 'running')
        if active['index'] == 7:
            raise RuntimeError('연결 시간이 초과되었습니다.')
        return {'text': '{"entities":[],"relations":[],"issues":[]}'}
    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=connection)).analyze(project.id, 'luna', 'medium')
    assert len(calls) == 12  # nine successes, three attempts on window seven
    assert clock[0] == pytest.approx(3)  # 1s, 2s backoff without a real wait
    assert result['published'] is False
    assert repo.latest_analysis_job(project.id).window_details[6]['attempts'] == 3
    retry_calls = []
    def retry(*args, **kwargs):
        retry_calls.append(args)
        return {'text': '{"entities":[],"relations":[],"issues":[]}'}
    analyzer = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=retry))
    result = analyzer.analyze(project.id, 'luna', 'medium')
    assert len(retry_calls) == 1 and result['cached_count'] == 9
    assert result['published'] is True
    # Replacing one original invalidates only its content window; unchanged
    # chapters keep their validated checkpoints.
    repo.replace_chunks(project.id, rows[0]['document_id'], ['계약 규칙이 수정되었다.'])
    analyzer.analyze(project.id, 'luna', 'medium')
    assert len(retry_calls) == 2


def test_author_setting_change_during_request_prevents_publication(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    old = repo.add_issue(project.id, 'low', 'contradiction', '이전 결과', '보존', ids)
    def connection(*args, **kwargs):
        repo.add_story_setting(project.id, '새 규칙', '유나는 검을 쓸 수 있다.', 'confirmed')
        return {'text': '{"entities":[],"relations":[],"issues":[]}'}
    with pytest.raises(RuntimeError, match='설정'):
        GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=connection)).analyze(project.id, 'model', 'medium')
    assert repo.graph(project.id).issues[0].id == old.id


def test_grouped_window_exposes_real_ids_and_keeps_late_paragraph_evidence(tmp_path):
    import re
    repo = StoryRepository(Database(tmp_path / 'grouped.sqlite'))
    project = repo.create_project('긴 원고')
    texts = [f'유나는 {i}번 기록을 읽었다.' for i in range(21)]
    doc = repo.add_document(project.id, tmp_path / 'long.txt', '긴 회차', 'txt', 'long', '\n'.join(texts), 0)
    ids = repo.replace_chunks(project.id, doc.id, texts)
    rag = SimpleNamespace(sync_project=lambda _: 21, retrieve=lambda *a, **k: [])
    def complete(model, prompt, **kwargs):
        match = re.search(r'현재 구간 ID 목록: (\[.*?\])', prompt)
        assert match is not None
        current_ids = json.loads(match[1])
        last = current_ids[-1]
        return {'text': json.dumps({'entities': [{'id': 'u', 'type': 'character', 'name': '유나',
            'summary': '기록을 읽는 인물', 'evidence': [{'chunk_id': last, 'quote': texts[ids.index(last)]}]}],
            'relations': [], 'issues': []})}
    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'model', 'medium')
    assert result['request_count'] == 2
    assert result['entity_count'] == 1


def test_grouped_window_obeys_character_budget_for_large_chunks(tmp_path):
    import re
    repo = StoryRepository(Database(tmp_path / 'grouped-budget.sqlite'))
    project = repo.create_project('큰 문단')
    texts = [f'유나는 {i}번 기록을 읽었다. ' + ('긴 문장. ' * 700) for i in range(21)]
    doc = repo.add_document(project.id, tmp_path / 'long.txt', '긴 회차', 'txt', 'long', '\n'.join(texts), 0)
    ids = repo.replace_chunks(project.id, doc.id, texts)
    rag = SimpleNamespace(sync_project=lambda _: 21, retrieve=lambda *a, **k: [])
    calls = []

    def complete(model, prompt, **kwargs):
        current = json.loads(re.search(r'현재 구간 ID 목록: (\[.*?\])', prompt)[1])
        calls.append(current)
        return {'text': '{"entities": [], "relations": [], "issues": []}'}

    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'model', 'medium')
    assert result['published'] is True
    assert len(calls) > 2
    assert max(len(current) for current in calls) <= 2


def test_timeout_detector_accepts_common_provider_wording():
    from backend.app.pipeline.gpt_review_window import response_timed_out
    assert response_timed_out(RuntimeError('request timed out'))
    assert response_timed_out(RuntimeError('deadline exceeded'))
    assert not response_timed_out(RuntimeError('권한이 거부되었습니다'))


def test_gpt_response_format_is_repaired_before_skipping_window(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    calls = []

    def complete(model, prompt, **kwargs):
        calls.append(prompt)
        if len(calls) == 1:
            return {'text': '분석 결과입니다. ```json {"issues": []} ```'}
        return {'text': '{"entities": [], "relations": [], "issues": []}'}

    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'model', 'low')
    assert result['failed_window_count'] == 0
    assert len(calls) == 2  # wrapper was normalized; one request per window


def test_gpt_prompt_includes_author_settings_with_certainty(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    repo.add_story_setting(project.id, '봉인검 규칙', '정식 계약자만 봉인검을 사용할 수 있다.', 'confirmed')
    repo.add_story_setting(project.id, '후반 반전 아이디어', '유나가 예외 계약을 맺을 수 있다.', 'draft')
    prompts = []

    def complete(model, prompt, **kwargs):
        prompts.append(prompt)
        return {'text': '{"entities": [], "relations": [], "issues": []}'}

    GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'model', None)
    assert len(prompts) == 2
    assert '확정 설정(충돌 판정 기준)' in prompts[0]
    assert '구상 메모(확정 아님, 참고만)' in prompts[0]
    assert '정식 계약자만 봉인검을 사용할 수 있다.' in prompts[0]


def test_invalid_evidence_does_not_replace_previous_results(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    old = repo.add_issue(project.id, 'low', 'contradiction', '이전 결과', '유지해야 함', ids)
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': json.dumps({'entities': [], 'relations': [], 'issues': [{'title': '잘못된 근거', 'description': '다른 작품', 'severity': 'high', 'evidence_chunk_ids': [999,1000]}]})})
    result = GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', None)
    assert result['published'] is False
    assert result['failed_window_count'] == 2
    assert repo.graph(project.id).issues[0].id == old.id
    assert repo.latest_analysis_job(project.id).status.value == 'partial'


def test_manuscript_change_prevents_stale_commit(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    def complete(*args, **kwargs):
        repo.replace_chunks(project.id, repo.list_documents(project.id)[0].id, ['바뀐 원고'])
        return {'text': '{"entities": [], "relations": [], "issues": []}'}
    with pytest.raises(RuntimeError, match='원고'):
        GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'model', None)


def test_cancellation_preserves_previous_results(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    old = repo.add_issue(project.id, 'low', 'contradiction', '이전 결과', '유지', ids)
    def complete(*args, **kwargs):
        repo.cancel_analysis(project.id, preserve_results=True)
        return {'text': '{"entities": [], "relations": [], "issues": []}'}
    with pytest.raises(RuntimeError, match='취소'):
        GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'model', None)
    assert repo.graph(project.id).issues[0].id == old.id
    assert repo.latest_analysis_job(project.id).status.value == 'cancelled'


def test_repeated_cancel_route_preserves_results(tmp_path, monkeypatch):
    from backend.app import main
    repo, project, ids, rag = fixture(tmp_path)
    old = repo.add_issue(project.id, 'low', 'contradiction', '이전 결과', '유지', ids)
    repo.create_running_analysis_job(project.id, '검토', current_step='gpt_review', progress=10)
    monkeypatch.setattr(main, 'repository', repo)
    main.cancel_analysis(project.id)
    main.cancel_analysis(project.id)
    assert repo.graph(project.id).issues[0].id == old.id


def test_manuscript_endpoint_requires_consent():
    from fastapi.testclient import TestClient
    from backend.app.main import app
    response = TestClient(app).post('/projects/1/analyze/gpt', json={'model': 'model'})
    assert response.status_code == 400


def test_author_decision_is_not_reopened(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    old = repo.add_issue(project.id, 'low', 'contradiction', '작가가 확인함', '유지', ids)
    repo.update_issue_status(old.id, 'ignored')
    payload = {'entities': [], 'relations': [], 'issues': [{'title': '중복 후보', 'description': '동일 근거', 'severity': 'high', 'evidence_chunk_ids': ids}]}
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': json.dumps(payload)})
    GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', 'low')
    issues = repo.graph(project.id).issues
    assert len(issues) == 1
    assert issues[0].id == old.id and issues[0].status == 'ignored'


def graph_payload(ids):
    return {'issues': [], 'entities': [
        {'id': 'u', 'type': 'character', 'name': '유나', 'summary': '계약 없이 검을 쓰는 인물', 'evidence': [{'chunk_id': ids[1], 'quote': '유나는 계약 없이 검을 쓴다.'}]},
        {'id': 's', 'type': 'item', 'name': '검', 'summary': '계약자만 쓰는 검', 'evidence': [{'chunk_id': ids[0], 'quote': '계약자만 검을 쓴다.'}]},
    ], 'relations': [{'source': 'u', 'target': 's', 'type': '계약 없이 사용', 'explanation': '유나는 계약을 맺지 않은 상태로 검을 사용한다.', 'basis': 'explicit', 'evidence': [{'chunk_id': ids[1], 'quote': '유나는 계약 없이 검을 쓴다.'}]}]}


def test_graph_is_grounded_deduplicated_and_stable_on_rerun(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    payload = graph_payload(ids)
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': json.dumps(payload)})
    analyzer = GptStoryAnalyzer(repo, rag, connection)
    result = analyzer.analyze(project.id, 'model', 'low')
    assert result['entity_count'] == 2 and result['relation_count'] == 1
    graph = repo.graph(project.id)
    assert graph.relations[0].type == '계약 없이 사용'
    assert graph.relations[0].evidence_chunk_ids == [ids[1]]
    assert graph.relations[0].origin == 'gpt'
    entity_ids = {e.name: e.id for e in graph.entities}
    analyzer.analyze(project.id, 'model', 'low')
    assert {e.name: e.id for e in repo.graph(project.id).entities} == entity_ids
    assert len(repo.graph(project.id).relations) == 1
    assert repo.list_documents(project.id)[0].analysis_status == 'analyzed'


def test_invalid_quote_gets_source_excerpt_repair_before_isolation(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    payload = graph_payload(ids)
    bad = json.loads(json.dumps(payload))
    bad['relations'][0]['evidence'][0]['quote'] = '원문에 없는 요약'
    calls = []

    def complete(model, prompt, **kwargs):
        calls.append(prompt)
        return {'text': json.dumps(bad if len(calls) == 1 else payload, ensure_ascii=False)}

    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'model', 'low')
    assert result['failed_window_count'] == 0
    assert len(calls) >= 2
    repair_calls = [prompt for prompt in calls if '검증용 원문 발췌' in prompt]
    assert repair_calls
    assert '유나는 계약 없이 검을 쓴다.' in repair_calls[0]


def test_graph_relation_labels_normalize_whitespace_and_unicode(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    payload = graph_payload(ids)
    payload['relations'].append({**payload['relations'][0], 'type': '  계약\u00a0없이   사용  '})
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': json.dumps(payload, ensure_ascii=False)})
    GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', 'low')
    relations = repo.graph(project.id).relations
    assert len(relations) == 1
    assert relations[0].type == '계약 없이 사용'


@pytest.mark.parametrize('corruption', ['quote', 'chunk', 'endpoint'])
def test_invalid_graph_preserves_previous_graph(tmp_path, corruption):
    repo, project, ids, rag = fixture(tmp_path)
    old = repo.upsert_entity(project.id, 'character', '기존 인물', [], '보존', None)
    payload = graph_payload(ids)
    if corruption == 'quote': payload['relations'][0]['evidence'][0]['quote'] = '원고에 없는 문장'
    if corruption == 'chunk': payload['relations'][0]['evidence'][0]['chunk_id'] = 999
    if corruption == 'endpoint': payload['relations'][0]['target'] = 'unknown'
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': json.dumps(payload)})
    result = GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', None)
    assert result['published'] is False
    assert result['failed_window_count'] == 2
    assert repo.graph(project.id).entities[0].id == old.id


def test_graph_contract_normalizes_omitted_empty_arrays(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': '{"issues": []}'})
    result = GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', None)
    assert result['failed_window_count'] == 0


def test_relation_evidence_endpoint_scopes_sources_to_project(tmp_path, monkeypatch):
    from backend.app import main
    from fastapi.testclient import TestClient
    repo, project, ids, rag = fixture(tmp_path)
    a = repo.upsert_entity(project.id, 'character', '유나', [], '', None)
    b = repo.upsert_entity(project.id, 'item', '검', [], '', None)
    other = repo.create_project('다른 작품')
    doc = repo.add_document(other.id, tmp_path / 'other.txt', '다른 원고', 'txt', 'x', '비공개 원고', 0)
    foreign_ids = repo.replace_chunks(other.id, doc.id, ['비공개 원고'])
    edge = repo.add_relation(project.id, a.id, b.id, '사용', 0.7, ids + foreign_ids)
    monkeypatch.setattr(main, 'repository', repo)
    client = TestClient(main.app)
    result = client.get(f'/relations/{edge.id}/evidence')
    assert result.status_code == 200
    assert [chunk['id'] for chunk in result.json()] == ids
    assert client.get('/relations/99999/evidence').status_code == 404


def test_graph_range_uses_cited_appearances_for_short_names(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': json.dumps(graph_payload(ids))})
    GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', 'low')
    graph = repo.graph(project.id, start_chapter=0, end_chapter=0)
    assert {node.name for node in graph.entities} == {'유나', '검'}
    assert len(graph.relations) == 1


def test_gpt_free_text_labels_do_not_claim_temporal_state_changes(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    repo.upsert_entity(project.id, 'character', '유나', [], '', None)
    repo.upsert_entity(project.id, 'item', '검', [], '', None)
    second = repo.add_document(project.id, tmp_path / 'next.txt', '후속', 'txt', 'next', '유나가 검을 사용한다.', 1)
    repo.replace_chunks(project.id, second.id, ['유나가 검을 사용한다.'])
    for doc, label in zip(repo.list_documents(project.id), ['계약 거절', '미계약 상태 사용']):
        repo.replace_episode_analysis(project.id, doc.id, doc.content_hash,
            {'entities': [], 'relations': [{'source': '유나', 'target': '검', 'type': label}]},
            model_name='model', prompt_version='gpt-evidence-graph-v1')
    assert repo.graph(project.id).changes == []


def test_identical_analysis_reuses_validated_requests_and_force_refreshes(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    calls = []
    def complete(*args, **kwargs):
        calls.append(args)
        return {'text': json.dumps(graph_payload(ids))}
    analyzer = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete))
    first = analyzer.analyze(project.id, 'model', 'low')
    assert len(calls) == 2
    second = analyzer.analyze(project.id, 'model', 'low')
    assert len(calls) == 2
    assert second['cached_count'] == 2 and second['request_count'] == 0
    analyzer.analyze(project.id, 'model', 'high')
    assert len(calls) == 4
    analyzer.analyze(project.id, 'model', 'low', force=True)
    assert len(calls) == 6


def test_changed_evidence_invalidates_cached_request(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    calls = []
    def complete(*args, **kwargs):
        calls.append(args)
        return {'text': json.dumps(graph_payload(ids))}
    analyzer = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete))
    analyzer.analyze(project.id, 'model', 'low')
    with repo.database.connect() as db:
        db.execute("UPDATE chunks SET text=text || ' 새로운 예외 조건.' WHERE id=?", (ids[0],))
    analyzer.analyze(project.id, 'model', 'low')
    # Only the changed chunk's window is requested again; the other window is
    # reused from the previous run.
    assert len(calls) == 3


def test_new_chapter_reuses_unchanged_review_windows(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    calls = []
    def complete(*args, **kwargs):
        calls.append(args)
        return {'text': json.dumps({'entities': [], 'relations': [], 'issues': []})}
    analyzer = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete))
    analyzer.analyze(project.id, 'model', 'low')
    assert len(calls) == 2
    document = repo.add_document(project.id, tmp_path / 'next.txt', '후속 회차', 'txt', 'next', '새로운 사건이 시작된다.', 1)
    repo.replace_chunks(project.id, document.id, ['새로운 사건이 시작된다.'])
    result = analyzer.analyze(project.id, 'model', 'low')
    assert len(calls) == 3
    assert result['cached_count'] == 2 and result['request_count'] == 1

def test_gpt_analysis_uses_hybrid_without_increasing_evidence_limit(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    original = rag.retrieve
    requested = []
    def retrieve(*args, **kwargs):
        requested.append(kwargs)
        return original(*args, **kwargs)
    rag.retrieve = retrieve
    connection = SimpleNamespace(complete=lambda *a, **k: {'text': '{"entities": [], "relations": [], "issues": []}'})
    GptStoryAnalyzer(repo, rag, connection).analyze(project.id, 'model', 'low')
    assert requested and all(k.get('strategy') == 'hybrid' and k['limit'] == 4 for k in requested)


def test_relation_explanation_and_exact_quotes_survive_storage(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    payload = graph_payload(ids)
    GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=lambda *a, **k: {'text': json.dumps(payload)})).analyze(project.id, 'model', 'low')
    claim = repo.graph(project.id).relations[0].claims[0]
    assert claim.explanation == payload['relations'][0]['explanation']
    assert claim.basis == 'explicit'
    assert claim.quotes[0].quote == '유나는 계약 없이 검을 쓴다.'
    assert claim.quotes[0].chapter_index == 0
    assert claim.quotes[0].document_id == repo.list_documents(project.id)[0].id


def test_vague_relationship_is_rejected_without_replacing_old_data(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    repo.upsert_entity(project.id, 'character', '기존', [], '', None)
    payload = graph_payload(ids)
    payload['relations'][0]['type'] = '관계'
    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=lambda *a, **k: {'text': json.dumps(payload)})).analyze(project.id, 'model', 'low')
    assert result['published'] is False
    assert result['failed_window_count'] == 2
    assert repo.graph(project.id).entities[0].name == '기존'


def test_range_does_not_leak_explanations_from_other_chapters(tmp_path):
    repo, project, ids, rag = fixture(tmp_path)
    payload = graph_payload(ids)
    GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=lambda *a, **k: {'text': json.dumps(payload)})).analyze(project.id, 'model', 'low')
    doc = repo.add_document(project.id, tmp_path/'later.txt', '나중', 'txt', 'later', '계약을 맺었다.', 1)
    other = repo.replace_chunks(project.id, doc.id, ['계약을 맺었다.'])[0]
    a = repo.upsert_entity(project.id, 'character', '유나', [], '', None)
    b = repo.upsert_entity(project.id, 'item', '검', [], '', None)
    repo.add_relation(project.id, a.id, b.id, '사용', .7, [ids[1]])
    with repo.database.connect() as db:
        claim = {'explanation':'나중 회차를 함께 읽어야 하는 해석', 'basis':'inferred', 'quotes':[
            {'chunk_id':ids[1], 'document_id':repo.list_documents(project.id)[0].id,'chapter_index':0,'quote':'유나는 계약 없이 검을 쓴다.'},
            {'chunk_id':other,'document_id':doc.id,'chapter_index':1,'quote':'계약을 맺었다.'}]}
        db.execute('UPDATE relations SET claims=? WHERE project_id=?',(json.dumps([claim]),project.id))
    assert len(repo.graph(project.id).relations[0].claims)==1
    assert repo.graph(project.id,start_chapter=0,end_chapter=0).relations[0].claims==[]


def test_timeout_splits_window_and_resumes_only_failed_part(tmp_path):
    import re
    repo = StoryRepository(Database(tmp_path / 'split.sqlite'))
    project = repo.create_project('분할 복구')
    texts = [f'유나는 {i}번 기록을 읽었다.' for i in range(21)]
    doc = repo.add_document(project.id, tmp_path / 'long.txt', '긴 회차', 'txt', 'long', '\n'.join(texts), 0)
    ids = repo.replace_chunks(project.id, doc.id, texts)
    old = repo.add_issue(project.id, 'low', 'contradiction', '기존 결과', '보존', ids[:2])
    rag = SimpleNamespace(sync_project=lambda _: 21, retrieve=lambda *a, **k: [])
    calls = []
    def complete(model, prompt, **kwargs):
        current = json.loads(re.search(r'현재 구간 ID 목록: (\[.*?\])', prompt)[1])
        calls.append(current)
        assert model == 'luna' and kwargs['effort'] == 'medium'
        if len(current) == 12:
            raise RuntimeError('GPT 응답 대기 시간이 초과되었습니다 (45초).')
        if current == ids[:6]:
            raise RuntimeError('모델 응답이 거부되었습니다')
        if current == ids[6:12]:
            # The split retains adjacent text across the cut as evidence.
            context = json.loads(prompt.split('원문 근거:\n')[1].split('\n이미 추출한')[0])
            assert ids[5] in [item['chunk_id'] for item in context]
        return {'text': '{"entities":[],"relations":[],"issues":[]}'}
    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'luna', 'medium')
    assert calls == [ids[:12], ids[:6], ids[6:12], ids[12:]]
    assert result['published'] is False
    assert repo.graph(project.id).issues[0].id == old.id
    parts = repo.latest_analysis_job(project.id).window_details[0]['parts']
    assert any(part['status'] == 'failed' and part['chunk_ids'] == ids[:6] for part in parts)
    calls.clear()
    def retry(model, prompt, **kwargs):
        calls.append(json.loads(re.search(r'현재 구간 ID 목록: (\[.*?\])', prompt)[1]))
        return {'text': '{"entities":[],"relations":[],"issues":[]}'}
    restarted_repo = StoryRepository(Database(tmp_path / 'split.sqlite'))
    result = GptStoryAnalyzer(restarted_repo, rag, SimpleNamespace(complete=retry)).analyze(project.id, 'luna', 'medium')
    assert calls == [ids[:6]]
    assert result['published'] is True


def test_repeated_response_timeouts_have_bounded_splits(tmp_path):
    import re
    repo = StoryRepository(Database(tmp_path / 'bounded.sqlite'))
    project = repo.create_project('분할 상한')
    texts = [f'유나는 {i}번 기록을 읽었다.' for i in range(24)]
    doc = repo.add_document(project.id, tmp_path / 'long.txt', '긴 회차', 'txt', 'long', '\n'.join(texts), 0)
    ids = repo.replace_chunks(project.id, doc.id, texts)
    rag = SimpleNamespace(sync_project=lambda _: 24, retrieve=lambda *a, **k: [])
    calls = []
    def complete(model, prompt, **kwargs):
        calls.append(json.loads(re.search(r'현재 구간 ID 목록: (\[.*?\])', prompt)[1]))
        raise RuntimeError('GPT 응답 대기 시간이 초과되었습니다 (45초).')
    analyzer = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete))
    first = analyzer.analyze(project.id, 'luna', 'medium')
    assert first['published'] is False
    assert first['failed_window_count'] == 2
    assert repo.latest_analysis_job(project.id).status.value == 'partial'
    assert len(calls) == 14  # each root: one 12 + two 6 + four 3
    assert min(map(len, calls)) == 3
    calls.clear()
    second = analyzer.analyze(project.id, 'luna', 'medium')
    assert second['published'] is False
    assert second['failed_window_count'] == 2
    assert repo.latest_analysis_job(project.id).status.value == 'partial'
    assert len(calls) == 8  # already failed large parents are not repeated
    assert all(len(current) == 3 for current in calls)


def test_cancellation_during_split_stops_siblings(tmp_path):
    import re
    repo = StoryRepository(Database(tmp_path / 'cancel-split.sqlite'))
    project = repo.create_project('분할 취소')
    texts = [f'유나는 {i}번 기록을 읽었다.' for i in range(21)]
    doc = repo.add_document(project.id, tmp_path / 'long.txt', '긴 회차', 'txt', 'long', '\n'.join(texts), 0)
    repo.replace_chunks(project.id, doc.id, texts)
    rag = SimpleNamespace(sync_project=lambda _: 21, retrieve=lambda *a, **k: [])
    calls = []
    def complete(model, prompt, **kwargs):
        current = json.loads(re.search(r'현재 구간 ID 목록: (\[.*?\])', prompt)[1])
        calls.append(current)
        if len(current) == 12:
            raise RuntimeError('GPT 응답 대기 시간이 초과되었습니다 (45초).')
        raise RuntimeError('GPT 분석이 취소되었습니다.')
    with pytest.raises(RuntimeError, match='취소'):
        GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'luna', 'medium')
    assert len(calls) == 2


def test_split_boundary_issue_and_quotes_survive_resume(tmp_path):
    import re
    repo = StoryRepository(Database(tmp_path / 'boundary.sqlite'))
    project = repo.create_project('경계 근거')
    texts = [f'유나는 {i}번 기록을 읽었다.' for i in range(21)]
    texts[5:7] = ['계약자만 봉인검을 사용한다.', '유나는 계약 없이 봉인검을 사용했다.']
    doc = repo.add_document(project.id, tmp_path / 'long.txt', '긴 회차', 'txt', 'long', '\n'.join(texts), 0)
    ids = repo.replace_chunks(project.id, doc.id, texts)
    rag = SimpleNamespace(sync_project=lambda _: 21, retrieve=lambda *a, **k: [])
    ready = False
    def complete(model, prompt, **kwargs):
        current = json.loads(re.search(r'현재 구간 ID 목록: (\[.*?\])', prompt)[1])
        if len(current) == 12:
            raise RuntimeError('GPT 응답 대기 시간이 초과되었습니다 (45초).')
        if current != ids[6:12]:
            if not ready:
                raise RuntimeError('모델 응답이 거부되었습니다')
            return {'text': '{"entities":[],"relations":[],"issues":[]}'}
        assert not ready  # second run must reuse this saved leaf without a request
        return {'text': json.dumps({'entities': [{
            'id': 'u', 'type': 'character', 'name': '유나', 'summary': '검 사용자',
            'evidence': [{'chunk_id': ids[6], 'quote': texts[6]}]}], 'relations': [],
            'issues': [{'title': '계약 조건 충돌 후보', 'description': '경계를 사이에 둔 규칙과 행동',
                        'severity': 'high', 'evidence_chunk_ids': ids[5:7]}]})}
    analyzer = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete))
    first = analyzer.analyze(project.id, 'luna', 'medium')
    assert first['published'] is False
    assert repo.latest_analysis_job(project.id).status.value == 'partial'
    ready = True
    result = analyzer.analyze(project.id, 'luna', 'medium')
    assert result['published'] is True
    assert repo.graph(project.id).issues[0].evidence_chunk_ids == ids[5:7]
    assert repo.graph(project.id).entities[0].name == '유나'


def test_quota_halts_remaining_chapters_and_resumes_saved_work(tmp_path, monkeypatch):
    from backend.app.services.gpt_errors import provider_error
    import backend.app.pipeline.gpt_analyzer as module
    clock = [0.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(module.time, 'sleep', lambda delay: clock.__setitem__(0, clock[0] + delay))
    repo = StoryRepository(Database(tmp_path / 'quota.sqlite'))
    project = repo.create_project('계정 한도 복구')
    for index in range(10):
        text = f'{index + 1}화. 유나는 항구의 기록을 확인했다.'
        doc = repo.add_document(project.id, tmp_path / f'{index}.txt', f'기록 {index + 1}', 'txt', str(index), text, index)
        repo.replace_chunks(project.id, doc.id, [text])
    rows = repo.list_chunks(project.id)
    old = repo.add_issue(project.id, 'low', 'contradiction', '기존 결과', '보존', [r['id'] for r in rows[:2]])
    rag = SimpleNamespace(sync_project=lambda _: 10, retrieve=lambda *a, **k: [])
    calls = []
    def complete(*args, **kwargs):
        calls.append(args)
        if len(calls) >= 3:
            raise provider_error({'codexErrorInfo': 'usageLimitExceeded'})
        return {'text': '{"entities":[],"relations":[],"issues":[]}'}
    with pytest.raises(RuntimeError, match='사용 한도'):
        GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'luna', 'medium')
    assert len(calls) == 3  # no identical retry; seven remaining chapters not requested
    assert clock[0] == 0
    job = repo.latest_analysis_job(project.id)
    assert job.progress < 100
    assert job.window_details[2]['error_code'] == 'usage_limit'
    assert all(item['status'] == 'deferred' for item in job.window_details[3:])
    assert repo.graph(project.id).issues[0].id == old.id
    calls.clear()
    def recovered(*args, **kwargs):
        calls.append(args)
        return {'text': '{"entities":[],"relations":[],"issues":[]}'}
    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=recovered)).analyze(project.id, 'luna', 'medium')
    assert len(calls) == 8 and result['cached_count'] == 2
    assert result['published'] is True


def test_input_limit_uses_bounded_split_instead_of_same_prompt_retry(tmp_path):
    import re
    from backend.app.services.gpt_errors import provider_error
    repo = StoryRepository(Database(tmp_path / 'input-limit.sqlite'))
    project = repo.create_project('입력 길이 분할')
    texts = [f'유나는 {i}번 기록을 읽었다.' for i in range(21)]
    doc = repo.add_document(project.id, tmp_path / 'long.txt', '긴 회차', 'txt', 'long', '\n'.join(texts), 0)
    ids = repo.replace_chunks(project.id, doc.id, texts)
    rag = SimpleNamespace(sync_project=lambda _: 21, retrieve=lambda *a, **k: [])
    calls = []
    def complete(model, prompt, **kwargs):
        current = json.loads(re.search(r'현재 구간 ID 목록: (\[.*?\])', prompt)[1])
        calls.append(current)
        if len(current) == 12:
            raise provider_error({'codexErrorInfo': 'contextWindowExceeded'})
        return {'text': '{"entities":[],"relations":[],"issues":[]}'}
    result = GptStoryAnalyzer(repo, rag, SimpleNamespace(complete=complete)).analyze(project.id, 'luna', 'medium')
    assert result['published'] is True
    assert calls == [ids[:12], ids[:6], ids[6:12], ids[12:]]

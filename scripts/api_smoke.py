"""OpenAI API 키 연결과 GPT 분석을 실행 중인 백엔드에 대고 확인하는 스모크 테스트.

백엔드를 먼저 띄운다 (개발 모드, 웹 모드 아님):

    OPENAI_API_KEY=sk-... npm run backend        # Windows: npm run backend:win

그다음:

    python -m scripts.api_smoke --model gpt-5.6-luna --effort low
    python -m scripts.api_smoke --model gpt-5.6-luna --effort low --analyze --project 1 --start 0 --end 1 --yes

단계:
  1. /chatgpt/status  연결 방식(api_key)과 상태
  2. /chatgpt/models  키로 쓸 수 있는 모델 목록에 --model 이 있는지
  3. /chatgpt/check   고정 샘플(봉인검 규칙 4문장)로 실제 응답 1회
  4. --analyze 일 때 /projects/{id}/analyze/gpt 로 선택 회차를 분석하고
     그래프·검토 후보·근거 인용을 출력한다. 실제 과금이 발생하므로 --yes 가 필요하다.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def call(base: str, method: str, path: str, body: dict | None = None, timeout: float = 60.0):
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    request = urllib.request.Request(base + path, data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode('utf-8')
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        raw = error.read().decode('utf-8', 'replace')
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {'detail': raw[:500]}


def fail(message: str) -> None:
    print(f'\n실패: {message}')
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--base', default='http://127.0.0.1:8765')
    parser.add_argument('--model', required=True, help='예: gpt-5.6-luna')
    parser.add_argument('--effort', default=None, help='low / medium / high (추론 모델만)')
    parser.add_argument('--analyze', action='store_true', help='실제 작품 분석까지 실행')
    parser.add_argument('--project', type=int, default=None, help='분석할 작품 ID (기본: 첫 작품)')
    parser.add_argument('--start', type=int, default=None, help='시작 회차 인덱스(0부터)')
    parser.add_argument('--end', type=int, default=None, help='끝 회차 인덱스(0부터)')
    parser.add_argument('--batch-limit', type=int, default=20)
    parser.add_argument('--yes', action='store_true', help='과금이 발생하는 분석 실행에 동의')
    args = parser.parse_args()
    base = args.base.rstrip('/')

    print('1) 연결 상태')
    status, state = call(base, 'GET', '/chatgpt/status')
    if status != 200:
        fail(f'/chatgpt/status {status}: {state}')
    print(f"   method={state.get('method', 'chatgpt')} phase={state['phase']} plan={state.get('plan')}")
    if state['phase'] != 'connected':
        fail(state.get('error') or '연결되지 않았습니다. OPENAI_API_KEY를 확인하세요.')

    print('2) 모델 목록')
    status, models = call(base, 'GET', '/chatgpt/models')
    if status != 200:
        fail(f'/chatgpt/models {status}: {models}')
    ids = [row['id'] for row in models]
    print('   ' + ', '.join(ids[:12]) + (' …' if len(ids) > 12 else ''))
    selected = next((row for row in models if row['id'] == args.model), None)
    if selected is None:
        fail(f'--model {args.model} 이(가) 목록에 없습니다. STORY_GUARD_OPENAI_MODELS 또는 키 권한을 확인하세요.')
    efforts = [option['value'] for option in selected['efforts']]
    if args.effort and args.effort not in efforts:
        fail(f'{args.model} 은(는) 추론 강도 {efforts or "없음"} 만 지원합니다.')

    print('3) 샘플 검증 (봉인검 규칙 4문장)')
    started = time.monotonic()
    status, result = call(base, 'POST', '/chatgpt/check', {'model': args.model, 'effort': args.effort}, timeout=240)
    elapsed = time.monotonic() - started
    if status != 200:
        fail(f'/chatgpt/check {status}: {result.get("detail") if isinstance(result, dict) else result}')
    print(f'   {elapsed:.1f}초 · 응답: {result["text"][:300]}')
    if '6화' not in result['text'] and '계약' not in result['text']:
        print('   주의: 응답이 6화 계약 성립을 언급하지 않습니다. 프롬프트·모델 선택을 확인하세요.')

    if not args.analyze:
        print('\n연결 검증 완료. 실제 작품 분석은 --analyze --yes 로 실행합니다.')
        return

    print('4) 작품 분석')
    status, projects = call(base, 'GET', '/projects')
    if status != 200 or not projects:
        fail('작품이 없습니다. 먼저 작품을 만들고 원고를 등록하세요.')
    project = next((row for row in projects if row['id'] == args.project), projects[0]) if args.project else projects[0]
    project_id = project['id']
    query = []
    if args.start is not None:
        query.append(f'start_chapter={args.start}')
    if args.end is not None:
        query.append(f'end_chapter={args.end}')
    status, plan = call(base, 'GET', f'/projects/{project_id}/analysis/plan' + ('?' + '&'.join(query) if query else ''))
    if status == 200:
        print(f"   작품 {project_id} '{project['title']}' · 원고 {plan['document_count']}편 · "
              f"청크 {plan['chunk_count']} · 검토 구간 {plan['review_window_count']}개 · 방식 {plan.get('mode')}")
    if not args.yes:
        fail('실제 GPT 요청이 검토 구간 수만큼 발생합니다. 동의하면 --yes 를 붙이세요.')

    body = {'model': args.model, 'effort': args.effort, 'consent': True, 'force': False,
            'batch_limit': args.batch_limit, 'start_chapter': args.start, 'end_chapter': args.end}
    started = time.monotonic()
    status, outcome = call(base, 'POST', f'/projects/{project_id}/analyze/gpt', body, timeout=60 * 60)
    elapsed = time.monotonic() - started
    if status != 200:
        fail(f'/analyze/gpt {status}: {outcome.get("detail") if isinstance(outcome, dict) else outcome}')
    print(f"   {elapsed:.0f}초 · 엔티티 {outcome.get('entity_count')} · 관계 {outcome.get('relation_count')} · "
          f"검토 후보 {outcome.get('issue_count')} · 게시 {outcome.get('published')}")
    failed = outcome.get('failed_windows') or []
    if failed:
        print(f'   실패 구간 {len(failed)}개: ' + '; '.join(str(item.get('error_code') or item.get('error') or item)[:80] for item in failed[:3]))

    status, graph = call(base, 'GET', f'/projects/{project_id}/graph')
    if status != 200:
        fail(f'/graph {status}')
    issues = graph.get('issues') or []
    print(f'   그래프: 엔티티 {len(graph.get("entities", []))} · 관계 {len(graph.get("relations", []))} · 이슈 {len(issues)}')
    for issue in issues[:5]:
        print(f"   - [{issue['severity']}] {issue['title']} · 근거 청크 {issue.get('evidence_chunk_ids')}")
    if issues:
        status, evidence = call(base, 'GET', f"/issues/{issues[0]['id']}/evidence")
        if status == 200:
            for chunk in evidence[:3]:
                print(f"     · chunk {chunk['id']} (문서 {chunk['document_id']}): {chunk['text'][:120].replace(chr(10), ' ')}…")
    print('\n분석 스모크 테스트 완료.')


if __name__ == '__main__':
    main()

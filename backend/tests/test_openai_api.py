"""OpenAI API-key connection: same surface as the ChatGPT login path, no Codex."""
import json

import httpx
import pytest

from backend.app.services.gpt_errors import GptRequestError
from backend.app.services.openai_api import OpenAiApiConnection

MODELS = {'data': [
    {'id': 'gpt-5.6-luna'}, {'id': 'gpt-5.4-mini'}, {'id': 'gpt-4.1'}, {'id': 'o3'},
    {'id': 'text-embedding-3-small'}, {'id': 'gpt-4o-realtime-preview'}, {'id': 'whisper-1'},
]}


def make_connection(handler, api_key='sk-test', monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.delenv('STORY_GUARD_OPENAI_MODELS', raising=False)
        monkeypatch.delenv('STORY_GUARD_OPENAI_MAX_OUTPUT_TOKENS', raising=False)
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return OpenAiApiConnection(api_key=api_key, base_url='https://api.example.test/v1', client=client)


def completion(text, finish_reason='stop', usage=None, refusal=None):
    message = {'role': 'assistant', 'content': text}
    if refusal:
        message['refusal'] = refusal
    return {'choices': [{'message': message, 'finish_reason': finish_reason}],
            'usage': usage or {'prompt_tokens': 120, 'completion_tokens': 40}}


def test_status_without_key_is_disconnected(monkeypatch):
    connection = make_connection(lambda request: httpx.Response(500), api_key='', monkeypatch=monkeypatch)
    state = connection.status()
    assert state['phase'] == 'disconnected'
    assert state['method'] == 'api_key'
    assert 'OPENAI_API_KEY' in state['error']
    with pytest.raises(RuntimeError):
        connection.models()


def test_models_filter_reasoning_efforts_and_cache(monkeypatch):
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path, request.headers.get('authorization')))
        return httpx.Response(200, json=MODELS)

    connection = make_connection(handler, monkeypatch=monkeypatch)
    models = connection.models()
    ids = [row['id'] for row in models]
    assert ids[0].startswith('gpt-5')
    assert 'text-embedding-3-small' not in ids
    assert 'gpt-4o-realtime-preview' not in ids
    assert 'whisper-1' not in ids
    luna = next(row for row in models if row['id'] == 'gpt-5.6-luna')
    assert luna['default_effort'] == 'medium'
    assert [option['value'] for option in luna['efforts']] == ['low', 'medium', 'high']
    plain = next(row for row in models if row['id'] == 'gpt-4.1')
    assert plain['efforts'] == [] and plain['default_effort'] is None
    connection.models()
    assert len(calls) == 1
    assert calls[0] == ('GET', '/v1/models', 'Bearer sk-test')
    assert connection.status()['phase'] == 'connected'
    assert connection.status()['plan'] == 'OpenAI API 키'


def test_models_allowlist_keeps_operator_order(monkeypatch):
    connection = make_connection(lambda request: httpx.Response(200, json=MODELS), monkeypatch=monkeypatch)
    monkeypatch.setenv('STORY_GUARD_OPENAI_MODELS', 'gpt-5.4-mini, gpt-5.6-luna')
    assert [row['id'] for row in connection.models()] == ['gpt-5.4-mini', 'gpt-5.6-luna']


def test_complete_sends_effort_schema_and_returns_text(monkeypatch):
    bodies = []

    def handler(request):
        if request.url.path.endswith('/models'):
            return httpx.Response(200, json=MODELS)
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=completion('{"entities": [], "relations": [], "issues": []}'))

    connection = make_connection(handler, monkeypatch=monkeypatch)
    monkeypatch.setenv('STORY_GUARD_OPENAI_MAX_OUTPUT_TOKENS', '9000')
    stages = []
    result = connection.complete('gpt-5.6-luna', '원고', effort='low',
                                 output_schema={'type': 'object'}, on_stage=stages.append)
    assert result['text'].startswith('{"entities"')
    assert result['model'] == 'gpt-5.6-luna' and result['effort'] == 'low'
    assert result['usage'] == {'input_tokens': 120, 'output_tokens': 40}
    assert stages == ['models', 'start', 'wait']
    body = bodies[0]
    assert body['model'] == 'gpt-5.6-luna'
    assert body['reasoning_effort'] == 'low'
    assert body['response_format']['type'] == 'json_schema'
    assert body['response_format']['json_schema']['schema'] == {'type': 'object'}
    assert body['max_completion_tokens'] == 9000
    assert body['messages'][-1] == {'role': 'user', 'content': '원고'}


def test_check_uses_fixed_sample_and_rejects_unknown_model_or_effort(monkeypatch):
    prompts = []

    def handler(request):
        if request.url.path.endswith('/models'):
            return httpx.Response(200, json=MODELS)
        prompts.append(json.loads(request.content)['messages'][-1]['content'])
        return httpx.Response(200, json=completion('6화에서 계약이 성립했으므로 위반이 아닙니다.'))

    connection = make_connection(handler, monkeypatch=monkeypatch)
    assert '6화' in connection.check('gpt-5.6-luna', 'high')['text']
    assert '봉인검' in prompts[0]
    with pytest.raises(RuntimeError, match='사용 가능'):
        connection.complete('gpt-9-unknown', '원고')
    with pytest.raises(RuntimeError, match='추론 강도'):
        connection.complete('gpt-4.1', '원고', effort='high')


@pytest.mark.parametrize('status, payload, code, retryable, stop_run', [
    (401, {'error': {'message': 'bad key'}}, 'authentication', False, True),
    (403, {'error': {'message': 'no access'}}, 'access_denied', False, True),
    (429, {'error': {'code': 'insufficient_quota', 'message': 'quota'}}, 'usage_limit', False, True),
    (429, {'error': {'code': 'rate_limit_exceeded', 'message': 'slow down'}}, 'rate_limit', True, False),
    (400, {'error': {'code': 'context_length_exceeded', 'message': 'too long'}}, 'context_length', False, False),
    (400, {'error': {'code': 'bad_param', 'message': 'nope'}}, 'invalid_request', False, True),
    (503, {'error': {'message': 'overloaded'}}, 'provider_unavailable', True, False),
])
def test_http_errors_map_to_safe_categories(monkeypatch, status, payload, code, retryable, stop_run):
    def handler(request):
        if request.url.path.endswith('/models'):
            return httpx.Response(200, json=MODELS)
        return httpx.Response(status, json=payload)

    connection = make_connection(handler, monkeypatch=monkeypatch)
    with pytest.raises(GptRequestError) as raised:
        connection.complete('gpt-5.6-luna', '원고', effort='low')
    assert raised.value.code == code
    assert raised.value.retryable is retryable
    assert raised.value.stop_run is stop_run


def test_missing_model_is_a_plain_selection_error(monkeypatch):
    def handler(request):
        if request.url.path.endswith('/models'):
            return httpx.Response(200, json=MODELS)
        return httpx.Response(404, json={'error': {'code': 'model_not_found', 'message': 'The model does not exist'}})

    connection = make_connection(handler, monkeypatch=monkeypatch)
    with pytest.raises(RuntimeError, match='선택한 모델을 사용할 수 없습니다'):
        connection.complete('gpt-5.6-luna', '원고', effort='low')


def test_timeout_reports_bounded_wait_for_window_splitting(monkeypatch):
    def handler(request):
        if request.url.path.endswith('/models'):
            return httpx.Response(200, json=MODELS)
        raise httpx.ReadTimeout('slow', request=request)

    connection = make_connection(handler, monkeypatch=monkeypatch)
    with pytest.raises(RuntimeError) as raised:
        connection.complete('gpt-5.6-luna', '원고', effort='low')
    assert 'GPT 응답 대기 시간이 초과되었습니다 (60초)' in str(raised.value)


def test_refusal_and_empty_answers(monkeypatch):
    responses = iter([
        completion('', refusal='I cannot help with that'),
        completion('', finish_reason='length'),
        completion('   '),
    ])

    def handler(request):
        if request.url.path.endswith('/models'):
            return httpx.Response(200, json=MODELS)
        return httpx.Response(200, json=next(responses))

    connection = make_connection(handler, monkeypatch=monkeypatch)
    with pytest.raises(GptRequestError) as raised:
        connection.complete('gpt-5.6-luna', '원고')
    assert raised.value.code == 'policy_rejection'
    with pytest.raises(RuntimeError, match='길이 제한'):
        connection.complete('gpt-5.6-luna', '원고')
    with pytest.raises(RuntimeError, match='비어 있습니다'):
        connection.complete('gpt-5.6-luna', '원고')


def test_cancelled_before_request_and_no_login_flow(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json=MODELS)

    connection = make_connection(handler, monkeypatch=monkeypatch)
    with pytest.raises(RuntimeError, match='취소'):
        connection.complete('gpt-5.6-luna', '원고', cancelled=lambda: True)
    assert all(path.endswith('/models') for path in calls)
    for action in (connection.login, connection.cancel, connection.logout, connection.open_verification):
        with pytest.raises(RuntimeError, match='로그인 절차가 없습니다'):
            action()
    connection.transport.close()

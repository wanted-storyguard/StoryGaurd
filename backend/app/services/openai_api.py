"""OpenAI API-key GPT connection for the hosted web demo.

Mirrors ``ChatGptConnection``'s surface (``status``/``models``/``check``/
``complete``) so ``GptStoryAnalyzer`` and the ``/chatgpt`` routes work
unchanged.  It talks to the chat completions endpoint over ``httpx``: no
Codex process, no device login, and the key lives only in the server
environment (``OPENAI_API_KEY``).
"""
from __future__ import annotations

import os
import re
import threading
import time

import httpx

from backend.app.services.chatgpt import CHECK_PROMPT
from backend.app.services.gpt_errors import GptRequestError, error_for_code

DEFAULT_BASE_URL = 'https://api.openai.com/v1'
SYSTEM_INSTRUCTIONS = ('Analyze only the supplied fictional text. Do not use tools, execute commands, '
                       'or inspect files. Follow the response format the user requests.')
REASONING_MODEL = re.compile(r'^(gpt-[5-9]|o[1-9])')
# Dated snapshots (gpt-5.4-2026-03-05) duplicate their alias; hide them so the
# list stays short and the newest alias is easy to find.
DATED_SNAPSHOT = re.compile(r'-\d{4}-\d{2}-\d{2}$')
MODEL_VERSION = re.compile(r'^gpt-(\d+)(?:\.(\d+))?')
EXCLUDED_MODEL_MARKERS = ('embedding', 'realtime', 'audio', 'tts', 'transcribe', 'image', 'moderation',
                          'search', 'instruct', 'whisper', 'dall-e', 'computer-use', 'codex')
EFFORTS = ('low', 'medium', 'high')
TIMEOUT_BY_EFFORT = {'low': 60, 'medium': 90, 'high': 120, 'xhigh': 150}
MODELS_CACHE_SECONDS = 30
NO_LOGIN_MESSAGE = 'API 키 연결에는 로그인 절차가 없습니다. 서버의 OPENAI_API_KEY로 연결됩니다.'


class _NoopTransport:
    """``main.py`` closes ``connection.transport`` on shutdown; nothing to close here."""

    def close(self) -> None:
        return None


def _model_rank(model_id: str) -> tuple[int, int, str]:
    """Newest GPT generation first, then o-series, then older GPT aliases."""
    version = MODEL_VERSION.match(model_id)
    if version and int(version.group(1)) >= 5:
        number = int(version.group(1)) * 100 + int(version.group(2) or 0)
        return (0, -number, model_id)
    if REASONING_MODEL.match(model_id):
        return (1, 0, model_id)
    if model_id.startswith('gpt-4.1'):
        return (2, 0, model_id)
    return (3, 0, model_id)


class OpenAiApiConnection:
    def __init__(self, api_key: str | None = None, base_url: str | None = None, client: httpx.Client | None = None):
        self.api_key = (api_key if api_key is not None else os.getenv('OPENAI_API_KEY', '')).strip()
        self.base_url = (base_url or os.getenv('OPENAI_BASE_URL') or DEFAULT_BASE_URL).rstrip('/')
        self.transport = _NoopTransport()
        self._client = client or httpx.Client(timeout=httpx.Timeout(30.0, read=180.0))
        self._lock = threading.Lock()
        self._models_cache: list[dict] | None = None
        self._models_cache_at = 0.0
        try:
            limit = int(os.getenv('STORY_GUARD_GPT_CONCURRENCY', '2') or 2)
        except ValueError:
            limit = 2
        self._slots = threading.BoundedSemaphore(max(1, limit))

    # -- status / login surface -------------------------------------------------

    def status(self):
        base = {'user_code': None, 'verification_url': None, 'method': 'api_key'}
        if not self.api_key:
            return {**base, 'phase': 'disconnected', 'plan': None,
                    'error': 'OPENAI_API_KEY가 설정되어 있지 않습니다. 서버 환경변수에 API 키를 넣어 주세요.'}
        try:
            self.models()
        except Exception as error:  # noqa: BLE001 - surfaced to the UI as text
            return {**base, 'phase': 'unavailable', 'plan': None, 'error': str(error)}
        return {**base, 'phase': 'connected', 'plan': 'OpenAI API 키', 'error': None}

    def login(self):
        raise RuntimeError(NO_LOGIN_MESSAGE)

    def cancel(self):
        raise RuntimeError(NO_LOGIN_MESSAGE)

    def logout(self):
        raise RuntimeError(NO_LOGIN_MESSAGE)

    def open_verification(self):
        raise RuntimeError(NO_LOGIN_MESSAGE)

    # -- models -----------------------------------------------------------------

    def models(self):
        if not self.api_key:
            raise RuntimeError('OPENAI_API_KEY가 설정되어 있지 않습니다.')
        with self._lock:
            if self._models_cache is not None and time.monotonic() - self._models_cache_at < MODELS_CACHE_SECONDS:
                return list(self._models_cache)
        payload = self._request('GET', '/models')
        ids = [row['id'] for row in payload.get('data', []) if isinstance(row, dict) and row.get('id')]
        allowlist = [value.strip() for value in os.getenv('STORY_GUARD_OPENAI_MODELS', '').split(',') if value.strip()]
        if allowlist:
            # The operator pins the demo models; keep their order. Fall back to
            # the list itself when /models does not enumerate them so a wrong
            # guess still fails at request time with a clear message.
            chosen = [value for value in allowlist if value in ids] or allowlist
        else:
            chosen = sorted((value for value in ids
                             if (value.startswith('gpt-') or REASONING_MODEL.match(value))
                             and not DATED_SNAPSHOT.search(value)
                             and not any(marker in value for marker in EXCLUDED_MODEL_MARKERS)),
                            key=_model_rank)[:60]
        models = [self._describe(value) for value in chosen]
        with self._lock:
            self._models_cache = list(models)
            self._models_cache_at = time.monotonic()
        return models

    @staticmethod
    def _describe(model_id: str) -> dict:
        reasoning = bool(REASONING_MODEL.match(model_id))
        return {'id': model_id, 'name': model_id,
                'default_effort': 'medium' if reasoning else None,
                'efforts': [{'value': value, 'description': ''} for value in EFFORTS] if reasoning else []}

    # -- completion -------------------------------------------------------------

    def check(self, model: str, effort: str | None = None):
        return self.complete(model, CHECK_PROMPT, effort=effort)

    def complete(self, model: str, prompt: str, effort: str | None = None,
                 output_schema: dict | None = None, cancelled=None, on_stage=None):
        report = on_stage or (lambda stage: None)
        report('models')
        available = self.models()
        selected = next((row for row in available if row['id'] == model), None)
        if selected is None:
            names = ', '.join(str(row.get('name') or row['id']) for row in available[:8])
            suffix = f' 사용 가능: {names}' if names else ' 이 API 키로 사용할 수 있는 모델이 없습니다.'
            raise RuntimeError(f'선택한 모델을 사용할 수 없습니다.{suffix}')
        if effort is not None and effort not in {option['value'] for option in selected['efforts']}:
            raise RuntimeError('선택한 모델에서 지원하는 추론 강도를 선택해 주세요.')
        if cancelled and cancelled():
            raise RuntimeError('GPT 분석이 취소되었습니다.')

        body: dict = {
            'model': model,
            'messages': [
                {'role': 'system', 'content': SYSTEM_INSTRUCTIONS},
                {'role': 'user', 'content': prompt},
            ],
        }
        if effort is not None:
            body['reasoning_effort'] = effort
        if output_schema is not None:
            body['response_format'] = {'type': 'json_schema',
                                       'json_schema': {'name': 'story_guard_review', 'schema': output_schema}}
        max_output = os.getenv('STORY_GUARD_OPENAI_MAX_OUTPUT_TOKENS', '').strip()
        if max_output.isdigit():
            body['max_completion_tokens'] = int(max_output)

        timeout = TIMEOUT_BY_EFFORT.get(effort or 'medium', 90)
        report('start')
        if not self._slots.acquire(timeout=30):
            raise RuntimeError('GPT 요청이 일시적으로 몰려 있습니다. 잠시 후 다시 시도해 주세요.')
        try:
            report('wait')
            payload = self._request('POST', '/chat/completions', json=body, read_timeout=timeout)
        finally:
            self._slots.release()

        choice = (payload.get('choices') or [{}])[0] if isinstance(payload, dict) else {}
        message = choice.get('message') or {}
        if message.get('refusal') or choice.get('finish_reason') == 'content_filter':
            raise error_for_code('policy_rejection')
        content = message.get('content')
        if isinstance(content, list):
            content = ''.join(part.get('text', '') for part in content if isinstance(part, dict))
        text = (content or '').strip()
        if not text:
            if choice.get('finish_reason') == 'length':
                raise RuntimeError('GPT 응답이 출력 길이 제한으로 잘렸습니다. 구간을 나누어 다시 시도해 주세요.')
            raise RuntimeError('분석 응답이 비어 있습니다.')
        usage = payload.get('usage') or {}
        return {'model': model, 'effort': effort, 'text': text,
                'usage': {'input_tokens': usage.get('prompt_tokens'), 'output_tokens': usage.get('completion_tokens')}}

    # -- transport --------------------------------------------------------------

    def _request(self, method: str, path: str, json: dict | None = None, read_timeout: float | None = None) -> dict:
        kwargs = {'headers': {'Authorization': f'Bearer {self.api_key}'}}
        if json is not None:
            kwargs['json'] = json
        if read_timeout is not None:
            kwargs['timeout'] = httpx.Timeout(30.0, read=read_timeout)
        try:
            response = self._client.request(method, self.base_url + path, **kwargs)
        except httpx.TimeoutException as error:
            raise RuntimeError(f'GPT 응답 대기 시간이 초과되었습니다 ({read_timeout or 30:.0f}초).') from error
        except httpx.HTTPError as error:
            raise error_for_code('provider_unavailable') from error
        if response.status_code >= 400:
            raise self._error(response)
        try:
            return response.json()
        except ValueError as error:
            raise RuntimeError('GPT 응답을 해석하지 못했습니다.') from error

    @staticmethod
    def _error(response: httpx.Response) -> Exception:
        status = response.status_code
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        info = payload.get('error') if isinstance(payload, dict) else None
        info = info if isinstance(info, dict) else {}
        code = str(info.get('code') or '')
        kind = str(info.get('type') or '')
        message = str(info.get('message') or '')
        if status == 401:
            return error_for_code('authentication')
        if status == 403:
            return error_for_code('access_denied')
        if status == 429:
            return error_for_code('usage_limit' if 'insufficient_quota' in (code, kind) else 'rate_limit')
        if status == 400 and code == 'context_length_exceeded':
            return error_for_code('context_length')
        if status in (400, 404) and (code == 'model_not_found' or 'does not exist' in message):
            return RuntimeError(f'선택한 모델을 사용할 수 없습니다. {message}'.strip())
        if 400 <= status < 500 and status != 408:
            return error_for_code('invalid_request')
        return error_for_code('provider_unavailable')


__all__ = ['OpenAiApiConnection', 'GptRequestError']

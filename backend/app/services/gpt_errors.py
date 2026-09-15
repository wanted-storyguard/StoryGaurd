"""Safe error categories from Codex's structured TurnError, never raw messages.

Protocol source: installed app-server generate-json-schema, CodexErrorInfo.
Unknown errors remain unknown; they must not be presented as a quota failure.
"""


class GptRequestError(RuntimeError):
    def __init__(self, code, message, *, retryable=False, stop_run=False):
        super().__init__(message)
        self.code, self.retryable, self.stop_run = code, retryable, stop_run


# code, user action, retry transient request, halt the remaining batch
_CATEGORIES = {
    'usage_limit': ('GPT 계정 사용 한도에 도달했습니다. 한도 회복 후 다시 시도해 주세요. 성공 구간은 유지됩니다.', False, True),
    'session_budget': ('GPT 세션 처리 한도에 도달했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.', False, True),
    'authentication': ('GPT 인증을 확인하지 못했습니다. AI 연결 화면에서 상태를 확인해 주세요.', False, True),
    'access_denied': ('GPT 요청 권한이 거부되었습니다. AI 연결과 모델 사용 권한을 확인해 주세요.', False, True),
    'rate_limit': ('GPT 요청이 일시적으로 제한되었습니다. 잠시 후 다시 시도합니다.', True, False),
    'provider_unavailable': ('GPT 서버 또는 응답 연결에 일시적인 문제가 있습니다.', True, False),
    'context_length': ('GPT 입력 길이 제한을 넘었습니다. 해당 구간을 나누어 처리합니다.', False, False),
    'invalid_request': ('GPT 요청 형식 또는 설정이 거부되었습니다. 앱과 모델 설정을 확인해 주세요.', False, True),
    'policy_rejection': ('GPT가 정책 사유로 요청을 거부했습니다. 자동 재시도를 중단했습니다.', False, True),
    'unknown_provider_error': ('GPT 요청이 실패했지만 구체적인 오류 종류는 제공되지 않았습니다. 해당 구간을 확인해 주세요.', False, False),
}

_INFO_CODES = {
    'usageLimitExceeded': 'usage_limit', 'sessionBudgetExceeded': 'session_budget',
    'unauthorized': 'authentication', 'rateLimitExceeded': 'rate_limit',
    'serverOverloaded': 'provider_unavailable', 'internalServerError': 'provider_unavailable',
    'contextWindowExceeded': 'context_length', 'badRequest': 'invalid_request',
    'cyberPolicy': 'policy_rejection', 'misalignmentPolicyViolation': 'policy_rejection',
}
_CONNECTION_CODES = {'httpConnectionFailed', 'responseStreamConnectionFailed',
                     'responseStreamDisconnected', 'responseTooManyFailedAttempts'}


def provider_error(payload):
    info = payload.get('codexErrorInfo') if isinstance(payload, dict) else None
    code = _INFO_CODES.get(info, 'unknown_provider_error') if isinstance(info, str) else 'unknown_provider_error'
    if isinstance(info, dict):
        for variant in _CONNECTION_CODES:
            if variant not in info:
                continue
            details = info[variant]
            status = details.get('httpStatusCode') if isinstance(details, dict) else None
            if status == 401:
                code = 'authentication'
            elif status == 403:
                code = 'access_denied'
            elif status == 429:
                code = 'rate_limit'
            elif isinstance(status, int) and 400 <= status < 500 and status != 408:
                code = 'invalid_request'
            else:
                code = 'provider_unavailable'
            break
    message, retryable, stop_run = _CATEGORIES[code]
    return GptRequestError(code, message, retryable=retryable, stop_run=stop_run)


def error_for_code(code: str) -> GptRequestError:
    """Build the user-facing error for a known category (API-key path and tests)."""
    known = code if code in _CATEGORIES else 'unknown_provider_error'
    message, retryable, stop_run = _CATEGORIES[known]
    return GptRequestError(known, message, retryable=retryable, stop_run=stop_run)

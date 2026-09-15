"""Pick the GPT connection for this process.

Desktop keeps the ChatGPT device login through a local Codex app-server.  A
hosted web server has no Codex and no user login, so it uses the operator's
OpenAI API key instead.  ``STORY_GUARD_GPT_PROVIDER`` forces one of the two;
otherwise a present ``OPENAI_API_KEY`` selects the API path.
"""
from __future__ import annotations

import os
from pathlib import Path


def gpt_provider_name() -> str:
    configured = os.getenv('STORY_GUARD_GPT_PROVIDER', 'auto').strip().lower()
    if configured in {'openai_api', 'api', 'api_key'}:
        return 'openai_api'
    if configured in {'chatgpt', 'codex'}:
        return 'chatgpt'
    return 'openai_api' if os.getenv('OPENAI_API_KEY', '').strip() else 'chatgpt'


def build_gpt_connection(data_dir: Path):
    if gpt_provider_name() == 'openai_api':
        from backend.app.services.openai_api import OpenAiApiConnection
        return OpenAiApiConnection()
    from backend.app.services.chatgpt import ChatGptConnection
    return ChatGptConnection(data_dir)

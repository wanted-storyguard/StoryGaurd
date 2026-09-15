from pathlib import Path

from backend.app.services.chatgpt import ChatGptConnection
from backend.app.services.gpt_connection import build_gpt_connection, gpt_provider_name
from backend.app.services.openai_api import OpenAiApiConnection


def test_api_key_selects_openai_api(monkeypatch, tmp_path: Path):
    monkeypatch.delenv('STORY_GUARD_GPT_PROVIDER', raising=False)
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-test')
    assert gpt_provider_name() == 'openai_api'
    assert isinstance(build_gpt_connection(tmp_path), OpenAiApiConnection)


def test_no_key_keeps_desktop_login(monkeypatch, tmp_path: Path):
    monkeypatch.delenv('STORY_GUARD_GPT_PROVIDER', raising=False)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    assert gpt_provider_name() == 'chatgpt'
    assert isinstance(build_gpt_connection(tmp_path), ChatGptConnection)


def test_explicit_provider_wins(monkeypatch, tmp_path: Path):
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-test')
    monkeypatch.setenv('STORY_GUARD_GPT_PROVIDER', 'chatgpt')
    assert gpt_provider_name() == 'chatgpt'
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.setenv('STORY_GUARD_GPT_PROVIDER', 'openai_api')
    assert isinstance(build_gpt_connection(tmp_path), OpenAiApiConnection)

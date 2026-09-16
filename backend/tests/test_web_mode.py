"""Public web demo guard: the hosted backend must not expose desktop-only surfaces."""
from fastapi.testclient import TestClient

from backend.app import main as main_module
from backend.app.main import app, bind_host, web_mode_allows, web_origins


def test_web_origins_parses_comma_separated_env(monkeypatch) -> None:
    monkeypatch.delenv("STORY_GUARD_WEB_ORIGINS", raising=False)
    assert web_origins() == []
    monkeypatch.setenv("STORY_GUARD_WEB_ORIGINS", " https://demo.example.com/, https://storyguard.vercel.app ,, ")
    assert web_origins() == ["https://demo.example.com", "https://storyguard.vercel.app"]


def test_bind_host_defaults_to_loopback(monkeypatch) -> None:
    monkeypatch.delenv("STORY_GUARD_BIND_HOST", raising=False)
    assert bind_host() == "127.0.0.1"
    monkeypatch.setenv("STORY_GUARD_BIND_HOST", "0.0.0.0")
    assert bind_host() == "0.0.0.0"


def test_desktop_default_has_no_guard(monkeypatch) -> None:
    monkeypatch.delenv("STORY_GUARD_WEB_MODE", raising=False)
    assert main_module.web_mode_enabled() is False
    client = TestClient(app)
    assert client.get("/health/ready").status_code == 200
    # Without web mode the desktop app keeps every write; the guard never
    # answers 403 (a validation error from the route itself is fine).
    response = client.post("/documents/import", json={})
    assert response.status_code != 403


def test_web_mode_blocks_desktop_only_paths_and_writes(monkeypatch) -> None:
    monkeypatch.setenv("STORY_GUARD_WEB_MODE", "1")
    monkeypatch.delenv("STORY_GUARD_WEB_WRITE_PATHS", raising=False)
    client = TestClient(app)

    assert client.get("/health").status_code == 200
    assert client.get("/health/ready").status_code == 200
    assert client.get("/projects").status_code == 200

    # Connection status and model listing stay readable so the web UI can
    # pick a model; the desktop login flow and the token-spending sample
    # check are closed.
    assert client.get("/chatgpt/status").status_code == 200

    blocked = [
        ("POST", "/shutdown"),
        ("POST", "/setup/run"),
        ("GET", "/setup/status"),
        ("POST", "/chatgpt/login"),
        ("POST", "/chatgpt/logout"),
        ("POST", "/chatgpt/check"),
        ("POST", "/documents/import"),
        ("GET", "/health/local-ai"),
        ("POST", "/projects"),
        ("PATCH", "/issues/1/status"),
        ("DELETE", "/projects/1"),
    ]
    for method, path in blocked:
        response = client.request(method, path, json={})
        assert response.status_code == 403, (method, path, response.status_code)
        assert "공개 웹 데모" in response.json()["detail"]


def test_web_mode_preflight_is_not_blocked(monkeypatch) -> None:
    monkeypatch.setenv("STORY_GUARD_WEB_MODE", "1")
    client = TestClient(app)
    response = client.options(
        "/projects",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.status_code == 200


def test_web_mode_writes_stay_closed_even_with_legacy_allowlist(monkeypatch) -> None:
    monkeypatch.setenv("STORY_GUARD_WEB_MODE", "1")
    monkeypatch.setenv("STORY_GUARD_WEB_WRITE_PATHS", r"/.*")
    assert web_mode_allows("POST", "/demo/review") is False
    assert web_mode_allows("POST", "/demo/sessions/12") is False
    assert web_mode_allows("POST", "/projects") is False
    assert web_mode_allows("POST", "/shutdown") is False
    assert web_mode_allows("POST", "/documents/import") is False


def test_web_mode_gpt_analysis_is_opt_in_and_invalid_requests_do_not_spend(monkeypatch) -> None:
    monkeypatch.setenv("STORY_GUARD_WEB_MODE", "1")
    monkeypatch.delenv("STORY_GUARD_WEB_ALLOW_GPT_ANALYZE", raising=False)
    client = TestClient(app)
    closed = client.post("/projects/1/analyze/gpt", json={"model": "m", "consent": True})
    assert closed.status_code == 403
    assert "GPT 분석" in closed.json()["detail"]

    monkeypatch.setenv("STORY_GUARD_WEB_ALLOW_GPT_ANALYZE", "1")
    monkeypatch.setenv("STORY_GUARD_WEB_GPT_RUNS_PER_SESSION", "1")
    monkeypatch.setenv("STORY_GUARD_WEB_GPT_RUNS_PER_IP", "10")
    monkeypatch.setenv("STORY_GUARD_WEB_GPT_RUNS_PER_DAY", "10")
    quota_before = client.get("/web-demo/quota")
    assert quota_before.status_code == 200
    assert quota_before.json()["remaining"] == 1

    first = client.post("/projects/1/analyze/gpt", json={"model": "m"})
    assert first.status_code == 400
    second = client.post("/projects/1/analyze/gpt", json={"model": "m"})
    assert second.status_code == 400
    assert client.get("/web-demo/quota").json()["remaining"] == 1
    # Cancelling is allowed alongside analysis and is not metered.
    assert client.post("/projects/1/analysis/cancel").status_code != 403


def test_web_mode_issues_signed_anonymous_session_cookie(monkeypatch) -> None:
    monkeypatch.setenv("STORY_GUARD_WEB_MODE", "1")
    client = TestClient(app)
    first = client.get("/web-demo/quota")
    assert first.status_code == 200
    assert "storyguard_demo_session=" in first.headers["set-cookie"]
    assert "HttpOnly" in first.headers["set-cookie"]
    second = client.get("/web-demo/quota")
    assert second.status_code == 200
    assert "set-cookie" not in second.headers

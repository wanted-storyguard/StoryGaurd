from __future__ import annotations

import pytest

from backend.app.database import Database
from backend.app.services.web_demo_quota import QuotaExceeded, QuotaLimits, WebDemoQuotaStore


def limits(*, session: int = 3, ip: int = 4, total: int = 5) -> QuotaLimits:
    return QuotaLimits(
        session=session,
        ip=ip,
        total=total,
        timezone_name="UTC",
        max_chapters=2,
        max_review_windows=4,
    )


def test_usage_survives_store_recreation(tmp_path) -> None:
    database = Database(tmp_path / "storyguard.sqlite3")
    store = WebDemoQuotaStore(database)
    snapshot = store.take("session-a", "203.0.113.1", limits())
    assert snapshot.remaining == 2

    recreated = WebDemoQuotaStore(database)
    persisted = recreated.status("session-a", "203.0.113.1", limits())
    assert persisted.used == 1
    assert persisted.ip_remaining == 3
    assert persisted.total_remaining == 4


def test_session_ip_and_global_limits_are_all_enforced(tmp_path) -> None:
    store = WebDemoQuotaStore(Database(tmp_path / "storyguard.sqlite3"))
    constrained = limits(session=2, ip=2, total=3)
    store.take("session-a", "203.0.113.1", constrained)
    store.take("session-b", "203.0.113.1", constrained)
    with pytest.raises(QuotaExceeded, match="네트워크"):
        store.take("session-c", "203.0.113.1", constrained)

    store.take("session-c", "203.0.113.2", constrained)
    with pytest.raises(QuotaExceeded, match="전체"):
        store.take("session-d", "203.0.113.3", constrained)


def test_signed_cookie_rejects_tampering(tmp_path) -> None:
    store = WebDemoQuotaStore(Database(tmp_path / "storyguard.sqlite3"))
    session_id, cookie, should_set = store.resolve_session(None)
    assert should_set is True
    assert store.resolve_session(cookie) == (session_id, cookie, False)

    replacement_id, replacement_cookie, replacement_should_set = store.resolve_session(cookie + "tampered")
    assert replacement_should_set is True
    assert replacement_id != session_id
    assert replacement_cookie != cookie

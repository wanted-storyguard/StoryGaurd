from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import asdict, dataclass
from datetime import datetime, time as datetime_time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from backend.app.database import Database


COOKIE_NAME = "storyguard_demo_session"
_SESSION_PATTERN = re.compile(r"^[A-Za-z0-9_-]{24,64}$")
_GLOBAL_SUBJECT = "all"
_SECRET_SETTING = "web_demo_cookie_secret"


@dataclass(frozen=True)
class QuotaLimits:
    session: int
    ip: int
    total: int
    timezone_name: str
    max_chapters: int
    max_review_windows: int


@dataclass(frozen=True)
class QuotaStatus:
    enabled: bool
    limit: int
    used: int
    remaining: int
    ip_limit: int
    ip_remaining: int
    total_limit: int
    total_remaining: int
    resets_at: str
    max_chapters: int
    max_review_windows: int

    def to_dict(self) -> dict[str, bool | int | str]:
        return asdict(self)


class QuotaExceeded(RuntimeError):
    pass


class WebDemoQuotaStore:
    """Persistent anonymous-session, IP, and global daily GPT run limits."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def resolve_session(self, cookie_value: str | None) -> tuple[str, str, bool]:
        """Return the session id, signed cookie, and whether a cookie must be set."""
        if cookie_value:
            session_id = self._verify_cookie(cookie_value)
            if session_id:
                return session_id, cookie_value, False
        session_id = secrets.token_urlsafe(24)
        return session_id, self._sign_cookie(session_id), True

    def status(self, session_id: str, client_ip: str, limits: QuotaLimits) -> QuotaStatus:
        usage_date, resets_at = self._day_window(limits.timezone_name)
        session_key = self._subject_key("session", session_id)
        ip_key = self._subject_key("ip", client_ip)
        with self.database.connect() as connection:
            counts = {
                (str(row["scope"]), str(row["subject_key"])): int(row["runs"])
                for row in connection.execute(
                    "SELECT scope, subject_key, runs FROM web_demo_daily_usage WHERE usage_date = ?",
                    (usage_date,),
                ).fetchall()
            }
        session_used = counts.get(("session", session_key), 0)
        ip_used = counts.get(("ip", ip_key), 0)
        total_used = counts.get(("global", _GLOBAL_SUBJECT), 0)
        return self._snapshot(session_used, ip_used, total_used, limits, resets_at)

    def take(self, session_id: str, client_ip: str, limits: QuotaLimits) -> QuotaStatus:
        usage_date, resets_at = self._day_window(limits.timezone_name)
        session_key = self._subject_key("session", session_id)
        ip_key = self._subject_key("ip", client_ip)
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            session_used = self._count(connection, usage_date, "session", session_key)
            ip_used = self._count(connection, usage_date, "ip", ip_key)
            total_used = self._count(connection, usage_date, "global", _GLOBAL_SUBJECT)
            if total_used >= limits.total:
                raise QuotaExceeded("오늘 공개 데모의 전체 GPT 분석 한도에 도달했습니다. 내일 다시 시도해 주세요.")
            if session_used >= limits.session:
                raise QuotaExceeded(
                    f"오늘 이 브라우저에서 실행할 수 있는 GPT 분석 {limits.session}회를 모두 사용했습니다."
                )
            if ip_used >= limits.ip:
                raise QuotaExceeded("이 네트워크의 오늘 GPT 분석 한도에 도달했습니다. 내일 다시 시도해 주세요.")
            self._increment(connection, usage_date, "session", session_key)
            self._increment(connection, usage_date, "ip", ip_key)
            self._increment(connection, usage_date, "global", _GLOBAL_SUBJECT)
        return self._snapshot(session_used + 1, ip_used + 1, total_used + 1, limits, resets_at)

    def _sign_cookie(self, session_id: str) -> str:
        signature = hmac.new(
            self._secret().encode("utf-8"), session_id.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return f"{session_id}.{signature}"

    def _verify_cookie(self, cookie_value: str) -> str | None:
        try:
            session_id, signature = cookie_value.rsplit(".", 1)
        except ValueError:
            return None
        if not _SESSION_PATTERN.fullmatch(session_id):
            return None
        expected = hmac.new(
            self._secret().encode("utf-8"), session_id.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return session_id if hmac.compare_digest(signature, expected) else None

    def _secret(self) -> str:
        with self.database.connect() as connection:
            row = connection.execute("SELECT value FROM settings WHERE key = ?", (_SECRET_SETTING,)).fetchone()
            if row is not None and str(row["value"]).strip():
                return str(row["value"])
            candidate = secrets.token_urlsafe(48)
            connection.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
                (_SECRET_SETTING, candidate),
            )
            row = connection.execute("SELECT value FROM settings WHERE key = ?", (_SECRET_SETTING,)).fetchone()
            return str(row["value"] if row is not None else candidate)

    @staticmethod
    def _subject_key(scope: str, value: str) -> str:
        return hashlib.sha256(f"{scope}:{value}".encode("utf-8")).hexdigest()

    @staticmethod
    def _count(connection, usage_date: str, scope: str, subject_key: str) -> int:
        row = connection.execute(
            "SELECT runs FROM web_demo_daily_usage WHERE usage_date = ? AND scope = ? AND subject_key = ?",
            (usage_date, scope, subject_key),
        ).fetchone()
        return int(row["runs"]) if row else 0

    @staticmethod
    def _increment(connection, usage_date: str, scope: str, subject_key: str) -> None:
        connection.execute(
            """
            INSERT INTO web_demo_daily_usage(usage_date, scope, subject_key, runs)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(usage_date, scope, subject_key) DO UPDATE SET
              runs = runs + 1,
              updated_at = CURRENT_TIMESTAMP
            """,
            (usage_date, scope, subject_key),
        )

    @staticmethod
    def _day_window(timezone_name: str) -> tuple[str, str]:
        try:
            zone = ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError:
            # Windows Python installations may not ship the IANA database.
            # Korea has no daylight-saving transition, so keep the documented
            # default correct without adding a deployment-only dependency.
            zone = timezone(timedelta(hours=9)) if timezone_name == "Asia/Seoul" else timezone.utc
        now = datetime.now(zone)
        next_day = datetime.combine(now.date() + timedelta(days=1), datetime_time.min, zone)
        return now.date().isoformat(), next_day.astimezone(timezone.utc).isoformat()

    @staticmethod
    def _snapshot(
        session_used: int,
        ip_used: int,
        total_used: int,
        limits: QuotaLimits,
        resets_at: str,
    ) -> QuotaStatus:
        return QuotaStatus(
            enabled=True,
            limit=limits.session,
            used=session_used,
            remaining=max(0, limits.session - session_used),
            ip_limit=limits.ip,
            ip_remaining=max(0, limits.ip - ip_used),
            total_limit=limits.total,
            total_remaining=max(0, limits.total - total_used),
            resets_at=resets_at,
            max_chapters=limits.max_chapters,
            max_review_windows=limits.max_review_windows,
        )

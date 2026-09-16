from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  root_path TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  format TEXT NOT NULL,
  chapter_index INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS story_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  certainty TEXT NOT NULL DEFAULT 'draft',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS foreshadowing_status (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unreviewed',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_offset INTEGER NOT NULL DEFAULT 0,
  end_offset INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  first_seen_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  UNIQUE(project_id, type, name)
);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  evidence_chunk_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS review_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
  evidence TEXT NOT NULL, fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  current_step TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gpt_review_runs (
  job_id INTEGER PRIMARY KEY REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_key TEXT NOT NULL,
  checkpoints TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS gpt_review_snapshot ON gpt_review_runs(project_id, snapshot_key, job_id);

CREATE TABLE IF NOT EXISTS document_analysis_cache (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  model_name TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  analyzed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS episode_entity_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.7,
  evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, entity_type, name)
);

CREATE TABLE IF NOT EXISTS episode_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  target_name TEXT NOT NULL,
  type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, source_name, target_name, type)
);

CREATE TABLE IF NOT EXISTS episode_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.7,
  evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gpt_request_cache (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  response TEXT NOT NULL,
  PRIMARY KEY(project_id, request_key)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_demo_daily_usage (
  usage_date TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(usage_date, scope, subject_key)
);
CREATE INDEX IF NOT EXISTS web_demo_daily_usage_scope
  ON web_demo_daily_usage(usage_date, scope);
"""


class Database:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def initialize(self) -> None:
        with sqlite3.connect(self.db_path) as connection:
            connection.executescript(SCHEMA)
            ensure_column(connection, 'analysis_jobs', 'window_details', "TEXT NOT NULL DEFAULT '[]'")
            ensure_column(connection, 'analysis_jobs', 'review_context', "TEXT NOT NULL DEFAULT '{}'")
            ensure_column(connection, "relations", "origin", "TEXT NOT NULL DEFAULT 'local'")
            ensure_column(connection, "relations", "claims", "TEXT NOT NULL DEFAULT '[]'")
            ensure_column(
                connection,
                "analysis_jobs",
                "current_step",
                "TEXT NOT NULL DEFAULT 'queued'",
            )
            ensure_column(
                connection,
                "analysis_jobs",
                "progress",
                "INTEGER NOT NULL DEFAULT 0",
            )
            ensure_column(
                connection,
                "chunks",
                "start_offset",
                "INTEGER NOT NULL DEFAULT 0",
            )
            ensure_column(
                connection,
                "chunks",
                "end_offset",
                "INTEGER NOT NULL DEFAULT 0",
            )
            ensure_column(
                connection,
                "document_analysis_cache",
                "model_name",
                "TEXT NOT NULL DEFAULT ''",
            )
            ensure_column(
                connection,
                "document_analysis_cache",
                "prompt_version",
                "TEXT NOT NULL DEFAULT ''",
            )


def ensure_column(
    connection: sqlite3.Connection,
    table_name: str,
    column_name: str,
    column_definition: str,
) -> None:
    columns = {
        str(row[1])
        for row in connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    if column_name not in columns:
        connection.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}")


def encode_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def decode_json(value: str | None) -> list:
    if not value:
        return []
    parsed = json.loads(value)
    return parsed if isinstance(parsed, list) else []

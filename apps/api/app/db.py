from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from app.paths import sqlite_path

_db: Optional[sqlite3.Connection] = None

MIGRATION_SQL = """
    CREATE TABLE IF NOT EXISTS campaign_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL UNIQUE,
      impressions INTEGER NOT NULL,
      clicks INTEGER NOT NULL,
      conversions INTEGER NOT NULL,
      attributed_conversions INTEGER NOT NULL,
      cost REAL NOT NULL,
      ctr REAL NOT NULL,
      conversion_rate REAL NOT NULL,
      attributed_conversion_rate REAL NOT NULL,
      cost_efficiency REAL NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_user_input TEXT NOT NULL,
      primary_goal TEXT NOT NULL,
      secondary_goals TEXT NOT NULL,
      budget_constraint REAL,
      efficiency_preference TEXT NOT NULL,
      protected_campaigns TEXT NOT NULL,
      risk_tolerance TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id INTEGER NOT NULL,
      summary TEXT NOT NULL,
      actions TEXT NOT NULL,
      reasoning_summary TEXT NOT NULL,
      evidence TEXT NOT NULL,
      risks TEXT NOT NULL,
      guardrail_status TEXT NOT NULL,
      simulation_result TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (goal_id) REFERENCES goals (id)
    );

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id INTEGER NOT NULL,
      campaign_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      change REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (strategy_id) REFERENCES strategies (id)
    );

    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id INTEGER NOT NULL,
      strategy_id INTEGER NOT NULL,
      user_action TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      details TEXT,
      FOREIGN KEY (strategy_id) REFERENCES strategies (id),
      FOREIGN KEY (goal_id) REFERENCES goals (id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      llm_provider TEXT NOT NULL,
      llm_model TEXT NOT NULL,
      llm_base_url TEXT NOT NULL,
      llm_api_key TEXT NOT NULL,
      max_single_adjustment REAL NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_logs (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id INTEGER NOT NULL,
      campaign_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      percentage REAL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (strategy_id) REFERENCES strategies (id)
    );

    CREATE TABLE IF NOT EXISTS data_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      source_type TEXT NOT NULL,
      metadata TEXT NOT NULL,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analysis_runs (
      id TEXT PRIMARY KEY,
      goal_id INTEGER,
      strategy_id INTEGER,
      status TEXT NOT NULL,
      run_type TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (goal_id) REFERENCES goals (id),
      FOREIGN KEY (strategy_id) REFERENCES strategies (id)
    );

    CREATE TABLE IF NOT EXISTS action_queue (
      id TEXT PRIMARY KEY,
      strategy_id INTEGER NOT NULL,
      campaign_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      percentage REAL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      confirmed_at TEXT,
      applied_at TEXT,
      dismissed_at TEXT,
      FOREIGN KEY (strategy_id) REFERENCES strategies (id)
    );

    CREATE TABLE IF NOT EXISTS actors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      title TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      finding_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      status TEXT NOT NULL,
      user_edited INTEGER NOT NULL DEFAULT 0,
      original_json TEXT NOT NULL,
      proposed_json TEXT NOT NULL,
      finding_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      recommendation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      modified INTEGER NOT NULL DEFAULT 0,
      diff_json TEXT NOT NULL,
      actor_id TEXT,
      confirmed_at TEXT,
      dismissed_at TEXT,
      exported_at TEXT,
      execution_mode TEXT,
      execution_result TEXT,
      observation_json TEXT,
      baseline_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recommendations_window ON recommendations (account_id, window_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events (entity_id, created_at);

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      title_custom INTEGER NOT NULL DEFAULT 0,
      context_type TEXT NOT NULL,
      campaign_id TEXT,
      finding_id TEXT,
      window_id TEXT NOT NULL,
      compare_label TEXT,
      snapshot_at TEXT,
      snapshot_label TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      client_key TEXT,
      evidence_json TEXT,
      sections_json TEXT,
      revision_json TEXT,
      mode TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (conversation_id, client_key)
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations (owner_id, account_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_messages ON conversation_messages (conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS investigation_reports (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      campaign_id TEXT,
      finding_id TEXT,
      window_id TEXT NOT NULL,
      snapshot_at TEXT,
      title TEXT NOT NULL,
      html TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_investigation_reports_conversation ON investigation_reports (conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS strategy_versions (
      id TEXT PRIMARY KEY,
      recommendation_id TEXT,
      finding_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      parent_version_id TEXT,
      conversation_id TEXT,
      message_id TEXT,
      proposal_json TEXT NOT NULL,
      source TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (finding_id, version_number)
    );

    CREATE INDEX IF NOT EXISTS idx_strategy_versions_finding ON strategy_versions (finding_id, version_number DESC);
"""


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    names = {row[1] for row in rows}
    if column not in names:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _col(columns: set[str], preferred: str, fallback: str) -> str:
    if preferred in columns:
        return preferred
    if fallback in columns:
        return fallback
    return "NULL"


def _rebuild_legacy_tables(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = OFF")
    _rebuild_decisions_table(conn)
    _rebuild_settings_table(conn)
    _rebuild_action_queue_table(conn)
    conn.execute("PRAGMA foreign_keys = ON")


def _rebuild_decisions_table(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "decisions")
    if "actor_id" in columns and "approver_id" not in columns and "confirmed_at" in columns and "approved_at" not in columns:
        return
    conn.executescript(
        """
        CREATE TABLE decisions_next (
          id TEXT PRIMARY KEY,
          recommendation_id TEXT NOT NULL,
          status TEXT NOT NULL,
          modified INTEGER NOT NULL DEFAULT 0,
          diff_json TEXT NOT NULL,
          actor_id TEXT,
          confirmed_at TEXT,
          dismissed_at TEXT,
          exported_at TEXT,
          execution_mode TEXT,
          execution_result TEXT,
          observation_json TEXT,
          baseline_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        """
    )
    actor = _col(columns, "actor_id", "approver_id")
    confirmed = _col(columns, "confirmed_at", "approved_at")
    dismissed = _col(columns, "dismissed_at", "rejected_at")
    exported = "exported_at" if "exported_at" in columns else "NULL"
    conn.executescript(
        f"""
        INSERT INTO decisions_next (
          id, recommendation_id, status, modified, diff_json, actor_id, confirmed_at, dismissed_at, exported_at,
          execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at
        )
        SELECT
          id, recommendation_id, status, modified, diff_json,
          CASE WHEN {actor} IN ('analyst', 'approver', 'admin', 'viewer') THEN 'user' ELSE {actor} END,
          {confirmed},
          {dismissed},
          COALESCE({exported}, CASE WHEN execution_mode = 'export' THEN updated_at END),
          execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at
        FROM decisions;
        DROP TABLE decisions;
        ALTER TABLE decisions_next RENAME TO decisions;
        CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status, updated_at);
        """
    )


def _rebuild_settings_table(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "settings")
    if "human_approval_required" not in columns and "notify_pending" not in columns:
        return
    conn.executescript(
        """
        CREATE TABLE settings_next (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          llm_provider TEXT NOT NULL,
          llm_model TEXT NOT NULL,
          llm_base_url TEXT NOT NULL,
          llm_api_key TEXT NOT NULL,
          max_single_adjustment REAL NOT NULL,
          analysis_min_clicks INTEGER DEFAULT 80,
          stale_after_days INTEGER DEFAULT 14,
          updated_at TEXT NOT NULL
        );
        INSERT INTO settings_next (
          id, llm_provider, llm_model, llm_base_url, llm_api_key, max_single_adjustment, analysis_min_clicks, stale_after_days, updated_at
        )
        SELECT
          id, llm_provider, llm_model, llm_base_url, llm_api_key, max_single_adjustment,
          COALESCE(analysis_min_clicks, 80), COALESCE(stale_after_days, 14), updated_at
        FROM settings;
        DROP TABLE settings;
        ALTER TABLE settings_next RENAME TO settings;
        """
    )


def _rebuild_action_queue_table(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "action_queue")
    if "confirmed_at" in columns and "approved_at" not in columns and "dismissed_at" in columns and "rejected_at" not in columns:
        return
    confirmed = _col(columns, "confirmed_at", "approved_at")
    dismissed = _col(columns, "dismissed_at", "rejected_at")
    conn.executescript(
        f"""
        CREATE TABLE action_queue_next (
          id TEXT PRIMARY KEY,
          strategy_id INTEGER NOT NULL,
          campaign_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          percentage REAL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          confirmed_at TEXT,
          applied_at TEXT,
          dismissed_at TEXT,
          FOREIGN KEY (strategy_id) REFERENCES strategies (id)
        );
        INSERT INTO action_queue_next (
          id, strategy_id, campaign_id, action_type, percentage, reason, status, created_at, updated_at, confirmed_at, applied_at, dismissed_at
        )
        SELECT
          id, strategy_id, campaign_id, action_type, percentage, reason, status, created_at, updated_at,
          {confirmed}, applied_at, {dismissed}
        FROM action_queue;
        DROP TABLE action_queue;
        ALTER TABLE action_queue_next RENAME TO action_queue;
        """
    )


def migrate_db(conn: sqlite3.Connection) -> None:
    conn.executescript(MIGRATION_SQL)
    _add_column_if_missing(conn, "goals", "parsed_goal", "TEXT")
    _add_column_if_missing(conn, "strategies", "title", "TEXT")
    _add_column_if_missing(conn, "strategies", "target_campaigns", "TEXT")
    _add_column_if_missing(conn, "strategies", "confidence", "REAL")
    _add_column_if_missing(conn, "analysis_runs", "progress", "TEXT")
    _add_column_if_missing(conn, "settings", "analysis_min_clicks", "INTEGER DEFAULT 80")
    _add_column_if_missing(conn, "settings", "stale_after_days", "INTEGER DEFAULT 14")
    _add_column_if_missing(conn, "conversation_messages", "answer_kind", "TEXT")
    _add_column_if_missing(conn, "conversation_messages", "review_ready", "INTEGER DEFAULT 0")
    _add_column_if_missing(conn, "conversations", "is_demo", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "conversations", "demo_key", "TEXT")
    _add_column_if_missing(conn, "conversations", "dataset_generated_at", "TEXT")
    _add_column_if_missing(conn, "recommendations", "dataset_version", "TEXT")
    _add_column_if_missing(conn, "decisions", "conversation_id", "TEXT")
    _add_column_if_missing(conn, "decisions", "parent_decision_id", "TEXT")
    _add_column_if_missing(conn, "decisions", "notes_json", "TEXT")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_demo_key ON conversations (demo_key) WHERE demo_key IS NOT NULL"
    )

    conn.execute(
        "INSERT OR IGNORE INTO actors (id, name, role, title) VALUES (?, ?, ?, ?)",
        ("user", "User", "user", "Reviews investigations and confirms or dismisses AI recommendations"),
    )
    conn.execute(
        "UPDATE actors SET name = ?, role = ?, title = ? WHERE id = ?",
        ("User", "user", "Reviews investigations and confirms or dismisses AI recommendations", "user"),
    )
    conn.execute(
        "UPDATE recommendations SET status = 'confirmed' WHERE status IN ('approved', 'exported', 'externally_marked')"
    )
    conn.execute("UPDATE recommendations SET status = 'dismissed' WHERE status = 'rejected'")
    conn.execute("UPDATE recommendations SET status = 'draft' WHERE status IN ('pending_review', 'expired')")
    conn.execute("UPDATE decisions SET status = 'confirmed' WHERE status IN ('approved', 'exported', 'externally_marked')")
    conn.execute("UPDATE decisions SET status = 'dismissed' WHERE status = 'rejected'")
    conn.execute("UPDATE decisions SET status = 'draft' WHERE status IN ('pending_review', 'expired')")
    conn.execute("UPDATE action_queue SET status = 'draft' WHERE status = 'pending_approval'")
    conn.execute("UPDATE action_queue SET status = 'confirmed' WHERE status = 'approved'")
    conn.execute("UPDATE action_queue SET status = 'dismissed' WHERE status = 'rejected'")
    conn.execute("UPDATE conversations SET owner_id = 'user' WHERE owner_id IN ('analyst', 'approver', 'admin', 'viewer')")
    conn.execute("UPDATE audit_events SET actor_id = 'user' WHERE actor_id IN ('analyst', 'approver', 'admin', 'viewer')")
    conn.execute(
        "UPDATE strategy_versions SET actor_id = 'user' WHERE actor_id IN ('analyst', 'approver', 'admin', 'viewer')"
    )
    _rebuild_legacy_tables(conn)
    conn.execute("DELETE FROM actors WHERE id != 'user'")

    row = conn.execute("SELECT id FROM settings WHERE id = 1").fetchone()
    if not row:
        conn.execute(
            """INSERT INTO settings (id, llm_provider, llm_model, llm_base_url, llm_api_key, max_single_adjustment, updated_at)
               VALUES (1, 'mock', 'gpt-4o-mini', 'https://api.openai.com/v1', '', 0.2, ?)""",
            (_iso_now(),),
        )

    source = conn.execute("SELECT id FROM data_sources WHERE id = ?", ("criteo-demo",)).fetchone()
    if not source:
        now = _iso_now()
        import json

        metadata = json.dumps(
            {
                "description": "Campaign performance and attribution data",
                "files": ["campaign_daily.csv", "campaign_summary.json", "campaign_facts.json"],
            }
        )
        conn.execute(
            """INSERT INTO data_sources (id, name, provider, status, source_type, metadata, last_synced_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "criteo-demo",
                "Primary ad account",
                "ad_account",
                "connected",
                "processed_file",
                metadata,
                None,
                now,
                now,
            ),
        )
    conn.execute(
        "UPDATE data_sources SET name = ? WHERE id = ?",
        ("Primary ad account", "criteo-demo"),
    )
    conn.execute(
        """UPDATE data_sources SET metadata = json_set(
             COALESCE(metadata, '{}'),
             '$.description',
             'Campaign performance and attribution data'
           ) WHERE id = ?""",
        ("criteo-demo",),
    )
    conn.commit()


def get_db() -> sqlite3.Connection:
    global _db
    if _db is not None:
        return _db
    path = sqlite_path()
    if not path.is_file():
        raise FileNotFoundError(
            f"SQLite database not found at {path}. Create or copy adpilot.db before starting the API."
        )
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    migrate_db(conn)
    _db = conn
    return conn


def next_id() -> str:
    return str(uuid.uuid4())


def to_json_list(value: list[str]) -> str:
    import json

    return json.dumps(value)


def from_json_list(value: str) -> list[str]:
    import json

    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        return []

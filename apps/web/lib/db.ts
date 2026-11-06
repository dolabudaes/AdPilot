import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveSqlitePath } from "./paths";

const DB_PATH = resolveSqlitePath();

let db: ReturnType<typeof Database> | null = null;

export function getDb() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrateDb(db);
  }
  return db;
}

function migrateDb(database: ReturnType<typeof Database>) {
  database.exec(`
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
  `);

  addColumnIfMissing(database, "goals", "parsed_goal", "TEXT");
  addColumnIfMissing(database, "strategies", "title", "TEXT");
  addColumnIfMissing(database, "strategies", "target_campaigns", "TEXT");
  addColumnIfMissing(database, "strategies", "confidence", "REAL");
  addColumnIfMissing(database, "analysis_runs", "progress", "TEXT");
  addColumnIfMissing(database, "settings", "analysis_min_clicks", "INTEGER DEFAULT 80");
  addColumnIfMissing(database, "settings", "stale_after_days", "INTEGER DEFAULT 14");
  addColumnIfMissing(database, "conversation_messages", "answer_kind", "TEXT");
  addColumnIfMissing(database, "conversation_messages", "review_ready", "INTEGER DEFAULT 0");
  addColumnIfMissing(database, "conversations", "is_demo", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "conversations", "demo_key", "TEXT");
  addColumnIfMissing(database, "conversations", "dataset_generated_at", "TEXT");
  addColumnIfMissing(database, "recommendations", "dataset_version", "TEXT");
  addColumnIfMissing(database, "decisions", "conversation_id", "TEXT");
  addColumnIfMissing(database, "decisions", "parent_decision_id", "TEXT");
  addColumnIfMissing(database, "decisions", "notes_json", "TEXT");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_demo_key ON conversations (demo_key) WHERE demo_key IS NOT NULL");

  database
    .prepare(`INSERT OR IGNORE INTO actors (id, name, role, title) VALUES (@id, @name, @role, @title)`)
    .run({
      id: "user",
      name: "User",
      role: "user",
      title: "Reviews investigations and confirms or dismisses AI recommendations",
    });
  database.exec(`
    UPDATE actors SET name = 'User', role = 'user', title = 'Reviews investigations and confirms or dismisses AI recommendations' WHERE id = 'user';
    UPDATE recommendations SET status = 'confirmed' WHERE status IN ('approved', 'exported', 'externally_marked');
    UPDATE recommendations SET status = 'dismissed' WHERE status = 'rejected';
    UPDATE recommendations SET status = 'draft' WHERE status IN ('pending_review', 'expired');
    UPDATE decisions SET status = 'confirmed' WHERE status IN ('approved', 'exported', 'externally_marked');
    UPDATE decisions SET status = 'dismissed' WHERE status = 'rejected';
    UPDATE decisions SET status = 'draft' WHERE status IN ('pending_review', 'expired');
    UPDATE action_queue SET status = 'draft' WHERE status = 'pending_approval';
    UPDATE action_queue SET status = 'confirmed' WHERE status = 'approved';
    UPDATE action_queue SET status = 'dismissed' WHERE status = 'rejected';
    UPDATE conversations SET owner_id = 'user' WHERE owner_id IN ('analyst', 'approver', 'admin', 'viewer');
    UPDATE audit_events SET actor_id = 'user' WHERE actor_id IN ('analyst', 'approver', 'admin', 'viewer');
    UPDATE strategy_versions SET actor_id = 'user' WHERE actor_id IN ('analyst', 'approver', 'admin', 'viewer');
  `);
  rebuildLegacyTables(database);
  database.exec(`DELETE FROM actors WHERE id != 'user';`);

  const row = database.prepare("SELECT id FROM settings WHERE id = 1").get();
  if (!row) {
    database
      .prepare(
        `INSERT INTO settings (id, llm_provider, llm_model, llm_base_url, llm_api_key, max_single_adjustment, updated_at)
         VALUES (1, 'mock', 'gpt-4o-mini', 'https://api.openai.com/v1', '', 0.2, @updatedAt)`
      )
      .run({ updatedAt: new Date().toISOString() });
  }

  const source = database.prepare("SELECT id FROM data_sources WHERE id = ?").get("criteo-demo");
  if (!source) {
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO data_sources (id, name, provider, status, source_type, metadata, last_synced_at, created_at, updated_at)
         VALUES (@id, @name, @provider, @status, @sourceType, @metadata, @lastSyncedAt, @createdAt, @updatedAt)`
      )
      .run({
        id: "criteo-demo",
        name: "Primary ad account",
        provider: "ad_account",
        status: "connected",
        sourceType: "processed_file",
        metadata: JSON.stringify({
          description: "Campaign performance and attribution data",
          files: ["campaign_daily.csv", "campaign_summary.json", "campaign_facts.json"],
        }),
        lastSyncedAt: null,
        createdAt: now,
        updatedAt: now,
      });
  }
  database.exec(`
    UPDATE data_sources SET name = 'Primary ad account'
    WHERE id = 'criteo-demo';
  `);
}

function addColumnIfMissing(database: ReturnType<typeof Database>, table: string, column: string, definition: string) {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableColumns(database: ReturnType<typeof Database>, table: string) {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function col(columns: Set<string>, preferred: string, fallback: string, extra = "") {
  if (columns.has(preferred)) return extra ? `${preferred}${extra}` : preferred;
  if (columns.has(fallback)) return extra ? `${fallback}${extra}` : fallback;
  return "NULL";
}

function rebuildLegacyTables(database: ReturnType<typeof Database>) {
  database.pragma("foreign_keys = OFF");
  rebuildDecisionsTable(database);
  rebuildSettingsTable(database);
  rebuildActionQueueTable(database);
  database.pragma("foreign_keys = ON");
}

function rebuildDecisionsTable(database: ReturnType<typeof Database>) {
  const columns = tableColumns(database, "decisions");
  if (columns.has("actor_id") && !columns.has("approver_id") && columns.has("confirmed_at") && !columns.has("approved_at")) {
    return;
  }
  database.exec(`
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
  `);
  const actor = col(columns, "actor_id", "approver_id");
  const confirmed = col(columns, "confirmed_at", "approved_at");
  const dismissed = col(columns, "dismissed_at", "rejected_at");
  const exported = columns.has("exported_at") ? "exported_at" : "NULL";
  database.exec(`
    INSERT INTO decisions_next (
      id, recommendation_id, status, modified, diff_json, actor_id, confirmed_at, dismissed_at, exported_at,
      execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at
    )
    SELECT
      id, recommendation_id, status, modified, diff_json,
      CASE WHEN ${actor} IN ('analyst', 'approver', 'admin', 'viewer') THEN 'user' ELSE ${actor} END,
      ${confirmed},
      ${dismissed},
      COALESCE(${exported}, CASE WHEN execution_mode = 'export' THEN updated_at END),
      execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at
    FROM decisions;
    DROP TABLE decisions;
    ALTER TABLE decisions_next RENAME TO decisions;
    CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status, updated_at);
  `);
}

function rebuildSettingsTable(database: ReturnType<typeof Database>) {
  const columns = tableColumns(database, "settings");
  if (!columns.has("human_approval_required") && !columns.has("notify_pending")) return;
  database.exec(`
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
  `);
}

function rebuildActionQueueTable(database: ReturnType<typeof Database>) {
  const columns = tableColumns(database, "action_queue");
  if (columns.has("confirmed_at") && !columns.has("approved_at") && columns.has("dismissed_at") && !columns.has("rejected_at")) {
    return;
  }
  const confirmed = col(columns, "confirmed_at", "approved_at");
  const dismissed = col(columns, "dismissed_at", "rejected_at");
  database.exec(`
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
      ${confirmed}, applied_at, ${dismissed}
    FROM action_queue;
    DROP TABLE action_queue;
    ALTER TABLE action_queue_next RENAME TO action_queue;
  `);
}

export function toJsonList(value: string[]) {
  return JSON.stringify(value);
}

export function fromJsonList(value: string) {
  try {
    return JSON.parse(value) as string[];
  } catch {
    return [];
  }
}

export function nextId() {
  return randomUUID();
}

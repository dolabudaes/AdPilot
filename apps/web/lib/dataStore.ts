import { getDb } from "./db";
import { aggregateCampaigns, loadDataset } from "./analytics";
import { nextId } from "./db";
import { RawCriteoRow } from "./types";
import { AdvertisingGoal, CampaignMetric, HistoryRecord, Strategy, StrategyAction } from "./types";

export type DataSourceRecord = {
  id: string;
  name: string;
  provider: string;
  status: "connected" | "pending" | "error";
  sourceType: string;
  metadata: Record<string, unknown>;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnalysisRunRecord = {
  id: string;
  goalId: number | null;
  strategyId: number | null;
  status: "running" | "completed" | "failed";
  runType: "strategy_analysis" | "simulation" | "data_import";
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type ActionQueueRecord = {
  id: string;
  strategyId: number;
  campaignId: string;
  actionType: StrategyAction["actionType"];
  percentage: number | null;
  reason: string;
  status: "draft" | "confirmed" | "applied" | "dismissed";
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  appliedAt: string | null;
  dismissedAt: string | null;
};

export function overwriteCampaignMetrics(rows: CampaignMetric[]) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM campaign_metrics").run();
    const insert = db.prepare(`
      INSERT INTO campaign_metrics (
        campaign_id, impressions, clicks, conversions, attributed_conversions, cost, ctr, conversion_rate, attributed_conversion_rate, cost_efficiency, updated_at
      ) VALUES (@campaign_id, @impressions, @clicks, @conversions, @attributed_conversions, @cost, @ctr, @conversion_rate, @attributed_conversion_rate, @cost_efficiency, @updatedAt)
    `);

    for (const m of rows) {
      insert.run({
        campaign_id: m.campaignId,
        impressions: m.impressions,
        clicks: m.clicks,
        conversions: m.conversions,
        attributed_conversions: m.attributedConversions,
        cost: m.cost,
        ctr: m.ctr,
        conversion_rate: m.conversionRate,
        attributed_conversion_rate: m.attributedConversionRate,
        cost_efficiency: m.costEfficiency,
        updatedAt: new Date().toISOString(),
      });
    }
  });

  tx();
}

export function importDataset(rows: RawCriteoRow[]) {
  const metrics = aggregateCampaigns(rows, 50);
  overwriteCampaignMetrics(metrics);
  touchDataSource("criteo-demo", {
    status: "connected",
    metadataPatch: {
      importMode: "file_import",
      lastImportedRows: rows.length,
      campaignCount: metrics.length,
    },
  });
  return { campaignCount: metrics.length, metrics };
}

export function ensureSeedData(sampleRows: RawCriteoRow[]) {
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) as c FROM campaign_metrics").get() as { c: number };
  if (count?.c === 0) {
    importDataset(sampleRows);
  }
}

export type SettingsRecord = {
  llm_provider: string;
  llm_model: string;
  llm_base_url: string;
  llm_api_key: string;
  max_single_adjustment: number;
  analysis_min_clicks: number;
  stale_after_days: number;
};

export function getSettings(): SettingsRecord {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT llm_provider, llm_model, llm_base_url, llm_api_key, max_single_adjustment,
              analysis_min_clicks, stale_after_days
       FROM settings WHERE id = 1`
    )
    .get() as SettingsRecord;
  return {
    ...row,
    analysis_min_clicks: Number(row.analysis_min_clicks ?? 80),
    stale_after_days: Number(row.stale_after_days ?? 14),
    max_single_adjustment: Number(row.max_single_adjustment ?? 0.2),
  };
}

export function saveSettings(settings: SettingsRecord) {
  const db = getDb();
  db.prepare(
    `
    UPDATE settings
    SET llm_provider = ?, llm_model = ?, llm_base_url = ?, llm_api_key = ?, max_single_adjustment = ?,
        analysis_min_clicks = ?, stale_after_days = ?, updated_at = ?
    WHERE id = 1
  `
  ).run(
    settings.llm_provider,
    settings.llm_model,
    settings.llm_base_url,
    settings.llm_api_key,
    settings.max_single_adjustment,
    Math.max(20, Math.round(settings.analysis_min_clicks || 80)),
    Math.max(1, Math.round(settings.stale_after_days || 14)),
    new Date().toISOString()
  );
}

export function setAnalysisProgress(id: string, progress: unknown) {
  const db = getDb();
  db.prepare("UPDATE analysis_runs SET progress = ? WHERE id = ?").run(JSON.stringify(progress), id);
}

export function createGoal(goal: AdvertisingGoal) {
  const db = getDb();
  const efficiencyPreference = goal.preferences.prioritizeCostEfficiency || goal.preferences.prioritizeConversion ? "high" : "balanced";
  const riskTolerance = goal.preferences.prioritizeRiskControl ? "low" : "medium";
  const result = db
    .prepare(
      `
      INSERT INTO goals (raw_user_input, primary_goal, secondary_goals, budget_constraint, efficiency_preference, protected_campaigns, risk_tolerance, parsed_goal, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      goal.rawInput,
      goal.primaryGoal,
      JSON.stringify(goal.secondaryGoals ?? []),
      null,
      efficiencyPreference,
      JSON.stringify([]),
      riskTolerance,
      JSON.stringify(goal),
      new Date().toISOString()
    );
  return Number(result.lastInsertRowid);
}

export function createStrategy({
  goalId,
  strategy,
  guardrailStatus,
}: {
  goalId: number;
  strategy: Strategy;
  guardrailStatus: string;
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `
      INSERT INTO strategies (goal_id, title, summary, target_campaigns, actions, reasoning_summary, evidence, risks, confidence, guardrail_status, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `
    )
    .run(
      goalId,
      strategy.title,
      strategy.summary,
      JSON.stringify(strategy.targetCampaigns),
      JSON.stringify(strategy.actions),
      strategy.summary,
      JSON.stringify(strategy.evidence),
      JSON.stringify(strategy.risks),
      strategy.confidence,
      guardrailStatus,
      now,
      now
    );
  const strategyId = Number(res.lastInsertRowid);
  insertStrategyActions(strategyId, strategy.actions, now);
  return strategyId;
}

function insertStrategyActions(strategyId: number, actions: StrategyAction[], now = new Date().toISOString()) {
  const db = getDb();
  const insertLegacyAction = db.prepare(`
    INSERT INTO actions (strategy_id, campaign_id, action_type, change, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertStrategyAction = db.prepare(`
    INSERT INTO strategy_actions (strategy_id, campaign_id, action_type, percentage, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const action of actions) {
    insertLegacyAction.run(strategyId, action.campaignId, action.actionType, action.percentage ?? 0, action.reason, now);
    insertStrategyAction.run(strategyId, action.campaignId, action.actionType, action.percentage ?? null, action.reason, now);
  }
}

export function updateStrategyStatus(strategyId: number, status: string, simulationResult?: string | null) {
  const db = getDb();
  if (simulationResult) {
    db.prepare("UPDATE strategies SET status = ?, simulation_result = ?, updated_at = ? WHERE id = ?").run(
      status,
      simulationResult,
      new Date().toISOString(),
      strategyId
    );
  } else {
    db.prepare("UPDATE strategies SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), strategyId);
  }
}

export function replaceStrategyActions(strategyId: number, actions: StrategyAction[] | string) {
  const db = getDb();
  const parsed = typeof actions === "string" ? (JSON.parse(actions) as StrategyAction[]) : actions;
  const strategy = db
    .prepare("SELECT goal_id, summary FROM strategies WHERE id = ?")
    .get(strategyId) as { goal_id: number; summary: string } | undefined;

  if (!strategy) return;

  const tx = db.transaction(() => {
    db.prepare("UPDATE strategies SET actions = ?, updated_at = ?, status = 'modified' WHERE id = ?").run(JSON.stringify(parsed), new Date().toISOString(), strategyId);
    db.prepare("DELETE FROM actions WHERE strategy_id = ?").run(strategyId);
    db.prepare("DELETE FROM strategy_actions WHERE strategy_id = ?").run(strategyId);
    insertStrategyActions(strategyId, parsed);
  });
  tx();
}

export function createHistoryRecord({
  goalId,
  strategyId,
  userAction,
  summary,
  details,
}: {
  goalId: number;
  strategyId: number;
  userAction: HistoryRecord["userAction"];
  summary: string;
  details: string;
}) {
  const db = getDb();
  db.prepare(
    `INSERT INTO history (goal_id, strategy_id, user_action, summary, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(goalId, strategyId, userAction, summary, details, new Date().toISOString());
}

export function listDataSources(): DataSourceRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, provider, status, source_type, metadata, last_synced_at, created_at, updated_at
       FROM data_sources
       ORDER BY created_at ASC`
    )
    .all() as Array<{
    id: string;
    name: string;
    provider: string;
    status: DataSourceRecord["status"];
    source_type: string;
    metadata: string;
    last_synced_at: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    sourceType: row.source_type,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function touchDataSource(
  id: string,
  update: {
    status?: DataSourceRecord["status"];
    metadataPatch?: Record<string, unknown>;
  } = {}
) {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db.prepare("SELECT metadata FROM data_sources WHERE id = ?").get(id) as { metadata: string } | undefined;
  if (!row) return null;
  const metadata = {
    ...parseJson<Record<string, unknown>>(row.metadata, {}),
    ...(update.metadataPatch || {}),
  };
  db.prepare(
    `UPDATE data_sources
     SET status = COALESCE(@status, status), metadata = @metadata, last_synced_at = @lastSyncedAt, updated_at = @updatedAt
     WHERE id = @id`
  ).run({
    id,
    status: update.status ?? null,
    metadata: JSON.stringify(metadata),
    lastSyncedAt: now,
    updatedAt: now,
  });
  return listDataSources().find((source) => source.id === id) || null;
}

export function createAnalysisRun({
  runType,
  input,
  goalId = null,
  strategyId = null,
}: {
  runType: AnalysisRunRecord["runType"];
  input: Record<string, unknown>;
  goalId?: number | null;
  strategyId?: number | null;
}) {
  const db = getDb();
  const id = nextId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO analysis_runs (id, goal_id, strategy_id, status, run_type, input, output, error, started_at, completed_at)
     VALUES (@id, @goalId, @strategyId, 'running', @runType, @input, NULL, NULL, @startedAt, NULL)`
  ).run({
    id,
    goalId,
    strategyId,
    runType,
    input: JSON.stringify(input),
    startedAt: now,
  });
  return id;
}

export function completeAnalysisRun(
  id: string,
  update: {
    goalId?: number | null;
    strategyId?: number | null;
    output?: Record<string, unknown> | null;
  }
) {
  const db = getDb();
  db.prepare(
    `UPDATE analysis_runs
     SET status = 'completed',
         goal_id = COALESCE(@goalId, goal_id),
         strategy_id = COALESCE(@strategyId, strategy_id),
         output = @output,
         completed_at = @completedAt
     WHERE id = @id`
  ).run({
    id,
    goalId: update.goalId ?? null,
    strategyId: update.strategyId ?? null,
    output: JSON.stringify(update.output || {}),
    completedAt: new Date().toISOString(),
  });
}

export function failAnalysisRun(id: string, error: string) {
  const db = getDb();
  db.prepare(
    `UPDATE analysis_runs
     SET status = 'failed', error = @error, completed_at = @completedAt
     WHERE id = @id`
  ).run({
    id,
    error,
    completedAt: new Date().toISOString(),
  });
}

export function listAnalysisRuns(limit = 25): AnalysisRunRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, goal_id, strategy_id, status, run_type, input, output, error, started_at, completed_at
       FROM analysis_runs
       ORDER BY started_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    goal_id: number | null;
    strategy_id: number | null;
    status: AnalysisRunRecord["status"];
    run_type: AnalysisRunRecord["runType"];
    input: string;
    output: string | null;
    error: string | null;
    started_at: string;
    completed_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    goalId: row.goal_id,
    strategyId: row.strategy_id,
    status: row.status,
    runType: row.run_type,
    input: parseJson<Record<string, unknown>>(row.input, {}),
    output: parseJson<Record<string, unknown> | null>(row.output, null),
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

export function enqueueStrategyActions(strategyId: number, actions: StrategyAction[]) {
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO action_queue (id, strategy_id, campaign_id, action_type, percentage, reason, status, created_at, updated_at)
     VALUES (@id, @strategyId, @campaignId, @actionType, @percentage, @reason, 'draft', @createdAt, @updatedAt)`
  );
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM action_queue WHERE strategy_id = ? AND status = 'draft'").run(strategyId);
    for (const action of actions) {
      insert.run({
        id: nextId(),
        strategyId,
        campaignId: action.campaignId,
        actionType: action.actionType,
        percentage: action.percentage ?? null,
        reason: action.reason,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  tx();
  return listActionQueue({ strategyId });
}

export function updateQueuedActionsForStrategy(strategyId: number, status: ActionQueueRecord["status"]) {
  const db = getDb();
  const now = new Date().toISOString();
  const timestampColumn =
    status === "confirmed" ? "confirmed_at" : status === "applied" ? "applied_at" : status === "dismissed" ? "dismissed_at" : null;
  const sql = timestampColumn
    ? `UPDATE action_queue SET status = @status, updated_at = @updatedAt, ${timestampColumn} = @updatedAt WHERE strategy_id = @strategyId`
    : `UPDATE action_queue SET status = @status, updated_at = @updatedAt WHERE strategy_id = @strategyId`;
  db.prepare(sql).run({ strategyId, status, updatedAt: now });
  return listActionQueue({ strategyId });
}

export function listActionQueue({
  limit = 50,
  strategyId,
  status,
}: {
  limit?: number;
  strategyId?: number;
  status?: ActionQueueRecord["status"];
} = {}): ActionQueueRecord[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (strategyId) {
    clauses.push("strategy_id = @strategyId");
    params.strategyId = strategyId;
  }
  if (status) {
    clauses.push("status = @status");
    params.status = status;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT id, strategy_id, campaign_id, action_type, percentage, reason, status, created_at, updated_at, confirmed_at, applied_at, dismissed_at
       FROM action_queue
       ${where}
       ORDER BY created_at DESC
       LIMIT @limit`
    )
    .all(params) as Array<{
    id: string;
    strategy_id: number;
    campaign_id: string;
    action_type: StrategyAction["actionType"];
    percentage: number | null;
    reason: string;
    status: ActionQueueRecord["status"];
    created_at: string;
    updated_at: string;
    confirmed_at: string | null;
    applied_at: string | null;
    dismissed_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    strategyId: row.strategy_id,
    campaignId: row.campaign_id,
    actionType: row.action_type,
    percentage: row.percentage,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    appliedAt: row.applied_at,
    dismissedAt: row.dismissed_at,
  }));
}

export function listStrategies(limit = 50) {
  const db = getDb();
  return db
    .prepare(
      `
      SELECT s.*, g.raw_user_input
      FROM strategies s
      INNER JOIN goals g ON g.id = s.goal_id
      ORDER BY s.created_at DESC
      LIMIT ?
    `
    )
    .all(limit) as Array<Record<string, unknown>>;
}

export function listCampaignMetrics() {
  return loadDataset(50).metrics;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function getStoredStrategy(strategyId: number) {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT s.*, g.raw_user_input, g.parsed_goal
      FROM strategies s
      INNER JOIN goals g ON g.id = s.goal_id
      WHERE s.id = ?
    `
    )
    .get(strategyId) as
    | {
        id: number;
        goal_id: number;
        title: string | null;
        summary: string;
        target_campaigns: string | null;
        actions: string;
        evidence: string;
        risks: string;
        confidence: number | null;
        guardrail_status: string;
        simulation_result: string | null;
        status: string;
        raw_user_input: string;
        parsed_goal: string | null;
      }
    | undefined;

  if (!row) return null;
  const strategy: Strategy = {
    id: row.id,
    title: row.title || "AdPilot strategy",
    summary: row.summary,
    targetCampaigns: parseJson<string[]>(row.target_campaigns, []),
    evidence: parseJson<Strategy["evidence"]>(row.evidence, []),
    actions: parseJson<StrategyAction[]>(row.actions, []),
    risks: parseJson<string[]>(row.risks, []),
    confidence: Number(row.confidence ?? 0.7),
  };

  return {
    strategy,
    goalId: row.goal_id,
    rawGoal: row.raw_user_input,
    parsedGoal: parseJson<AdvertisingGoal | null>(row.parsed_goal, null),
    guardrailStatus: row.guardrail_status,
    simulationResult: parseJson(row.simulation_result, null),
    status: row.status,
  };
}

export function listHistoryRecords(limit = 50): HistoryRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT h.id, h.user_action, h.created_at, h.details, h.summary, s.status
      FROM history h
      INNER JOIN strategies s ON s.id = h.strategy_id
      ORDER BY h.created_at DESC
      LIMIT ?
    `
    )
    .all(limit) as Array<{ user_action: HistoryRecord["userAction"]; created_at: string; details: string; summary: string; status: string }>;

  return rows.map((row) => {
    const details = parseJson<Partial<HistoryRecord>>(row.details, {});
    return {
      createdAt: row.created_at,
      rawGoal: details.rawGoal || row.summary,
      parsedGoal: details.parsedGoal as AdvertisingGoal,
      strategy: details.strategy as Strategy,
      userAction: row.user_action,
      modifiedStrategy: details.modifiedStrategy || null,
      status: row.status,
    };
  });
}

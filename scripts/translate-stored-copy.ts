import { getDb } from "../apps/web/lib/db";
import { englishProposalText, englishWindowLabel, hasChinese } from "../apps/web/lib/copilot/english-copy";

const db = getDb();

function translateValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (!hasChinese(value)) return value;
    return englishProposalText(value) || englishWindowLabel(value) || value.replace(/[\u3400-\u9fff]/g, " ").replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) return value.map(translateValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, translateValue(item)]));
  }
  return value;
}

function translateJson(raw: string | null) {
  if (!raw) return raw;
  try {
    return JSON.stringify(translateValue(JSON.parse(raw)));
  } catch {
    return hasChinese(raw) ? englishProposalText(raw) || raw : raw;
  }
}

function translateText(raw: string | null) {
  if (!raw || !hasChinese(raw)) return raw;
  if (raw.trim().startsWith("{") || raw.trim().startsWith("[")) return translateJson(raw);
  return englishProposalText(raw) || raw.replace(/[\u3400-\u9fff]/g, " ").replace(/\s+/g, " ").trim();
}

const TABLES: Array<{ table: string; id: string; columns: string[] }> = [
  { table: "recommendations", id: "id", columns: ["original_json", "proposed_json", "finding_json"] },
  { table: "decisions", id: "id", columns: ["execution_result", "observation_json", "baseline_json", "diff_json", "notes_json"] },
  { table: "conversation_messages", id: "id", columns: ["content", "evidence_json", "sections_json", "revision_json"] },
  { table: "conversations", id: "id", columns: ["title", "prompt", "snapshot_label", "compare_label"] },
  { table: "investigation_reports", id: "id", columns: ["title", "html"] },
  { table: "strategy_versions", id: "id", columns: ["proposal_json"] },
  { table: "audit_events", id: "id", columns: ["detail"] },
  { table: "findings", id: "id", columns: ["payload"] },
  { table: "strategies", id: "id", columns: ["title", "summary", "actions", "evidence", "risks"] },
  { table: "actions", id: "id", columns: ["reason"] },
  { table: "history", id: "id", columns: ["summary", "details"] },
  { table: "strategy_actions", id: "id", columns: ["reason"] },
  { table: "analysis_runs", id: "id", columns: ["input", "output"] },
  { table: "action_queue", id: "id", columns: ["reason"] },
  { table: "goals", id: "id", columns: ["raw_user_input"] },
];

const tx = db.transaction(() => {
  const changed: Record<string, number> = {};
  for (const spec of TABLES) {
    const cols = getDb().prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>;
    const available = new Set(cols.map((col) => col.name));
    if (!available.has(spec.id)) continue;
    const fields = spec.columns.filter((column) => available.has(column));
    if (!fields.length) continue;
    const rows = getDb().prepare(`SELECT ${[spec.id, ...fields].join(", ")} FROM ${spec.table}`).all() as Array<Record<string, string | null>>;
    const setters = fields.map((field) => `${field} = ?`).join(", ");
    const update = getDb().prepare(`UPDATE ${spec.table} SET ${setters} WHERE ${spec.id} = ?`);
    let count = 0;
    for (const row of rows) {
      const next = fields.map((field) => translateText(row[field] ?? null));
      const dirty = fields.some((field, index) => next[index] !== row[field]);
      if (!dirty) continue;
      update.run(...next, row[spec.id]);
      count += 1;
    }
    changed[spec.table] = count;
  }
  return changed;
});

const result = tx();
console.log("Translated stored copy:", result);

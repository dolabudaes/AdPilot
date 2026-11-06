import { getDb } from "@/lib/db";
import { saveStrategyVersion } from "@/lib/copilot/strategy-versions";
import type { FactCheck } from "./types";

const REASON = "Evaluation-only version. Confirm the daily window before any delivery change.";

export function checkDecisionPersistence(): FactCheck[] {
  const db = getDb();
  const recommendation = db.prepare(`SELECT finding_id, status FROM recommendations WHERE campaign_id = 'Campaign R'`).get() as
    | { finding_id: string; status: string }
    | undefined;
  if (!recommendation) return [{ id: "recommendation", ok: false, detail: "No stored recommendation was found for Campaign R." }];
  const decision = db.prepare(`SELECT status, execution_mode FROM decisions WHERE recommendation_id = ?`).get(`rec:${recommendation.finding_id}`) as
    | { status: string; execution_mode: string }
    | undefined;
  const before = Number((db.prepare(`SELECT COUNT(*) AS count FROM strategy_versions WHERE finding_id = ?`).get(recommendation.finding_id) as { count: number }).count);
  const checks: FactCheck[] = [];
  db.exec("BEGIN");
  try {
    const version = saveStrategyVersion({
      findingId: recommendation.finding_id,
      actionType: "review",
      reason: REASON,
      actorId: "user",
      source: "human",
    });
    const stored = db.prepare(`SELECT version_number, proposal_json FROM strategy_versions WHERE id = ?`).get(version.id) as
      | { version_number: number; proposal_json: string }
      | undefined;
    const proposal = stored ? (JSON.parse(stored.proposal_json) as { actionType?: string; reason?: string }) : null;
    const recommendationStatus = (db.prepare(`SELECT status FROM recommendations WHERE campaign_id = 'Campaign R'`).get() as { status: string }).status;
    const decisionAfter = db.prepare(`SELECT status, execution_mode FROM decisions WHERE recommendation_id = ?`).get(`rec:${recommendation.finding_id}`) as
      | { status: string; execution_mode: string }
      | undefined;
    checks.push({ id: "version-increment", ok: version.versionNumber === before + 1 && stored?.version_number === version.versionNumber, detail: `Read version ${stored?.version_number ?? "missing"}; expected ${before + 1}.` });
    checks.push({ id: "proposal-fields", ok: proposal?.actionType === "review" && proposal.reason === REASON, detail: "The saved proposal action and reason match the submitted values." });
    checks.push({ id: "recommendation-unchanged", ok: recommendationStatus === recommendation.status, detail: `Recommendation status remained ${recommendation.status}.` });
    checks.push({ id: "decision-unchanged", ok: Boolean(decision) && JSON.stringify(decisionAfter) === JSON.stringify(decision), detail: `Decision status remained ${decision?.status ?? "missing"}.` });
  } catch (error) {
    checks.push({ id: "round-trip", ok: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    db.exec("ROLLBACK");
  }
  const after = Number((db.prepare(`SELECT COUNT(*) AS count FROM strategy_versions WHERE finding_id = ?`).get(recommendation.finding_id) as { count: number }).count);
  checks.push({ id: "rollback", ok: after === before, detail: `Version count after rollback: ${after}; before: ${before}.` });
  return checks;
}

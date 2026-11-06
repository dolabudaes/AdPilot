import { randomUUID } from "node:crypto";
import type { ActionType } from "@/lib/analytics/types";
import { getDb } from "@/lib/db";
import { getConversationForActor } from "./conversations";
import { propose } from "./recommend";
import { buildProductModel, editFinding, parseFindingId } from "./service";
import { CopilotError, recommendationIdFor } from "./store";
import type { FindingDraft, FindingView, Proposal, StrategyVersion } from "./types";

type VersionRow = {
  id: string;
  recommendation_id: string | null;
  finding_id: string;
  account_id: string;
  window_id: string;
  campaign_id: string;
  version_number: number;
  parent_version_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  proposal_json: string;
  source: string;
  actor_id: string;
  created_at: string;
};

export function listStrategyVersions(findingId: string): StrategyVersion[] {
  const recommendationId = recommendationIdFor(findingId);
  const rows = getDb()
    .prepare(`SELECT * FROM strategy_versions WHERE finding_id = ? AND recommendation_id = ? ORDER BY version_number DESC`)
    .all(findingId, recommendationId) as VersionRow[];
  return rows.map(mapVersion);
}

export function listStrategyVersionsForRecommendation(recommendationId: string): StrategyVersion[] {
  const rows = getDb()
    .prepare(`SELECT * FROM strategy_versions WHERE recommendation_id = ? ORDER BY version_number DESC`)
    .all(recommendationId) as VersionRow[];
  return rows.map(mapVersion);
}

export function saveStrategyVersion(input: {
  findingId: string;
  actionType: ActionType;
  reason: string;
  actorId: string;
  source?: "ai" | "human";
  conversationId?: string | null;
  messageId?: string | null;
}): StrategyVersion {
  const parsed = parseFindingId(input.findingId);
  if (!parsed) throw new CopilotError("The finding identifier is invalid.");
  const model = buildProductModel({ accountId: parsed.accountId, windowId: parsed.windowId });
  const finding = model.findings.find((item) => item.id === input.findingId);
  if (!finding) throw new CopilotError("The finding is not available in this analysis window.", 404);
  const reason = input.reason.trim();
  if (reason.length < 8) throw new CopilotError("Add a clear rationale before saving this version.");

  if (input.conversationId) {
    const conversation = getConversationForActor(input.conversationId, input.actorId);
    if (conversation.accountId !== finding.accountId || conversation.findingId !== finding.id || conversation.windowId !== finding.windowId) {
      throw new CopilotError("The conversation does not belong to this investigation.", 409);
    }
  }

  const draft = asDraft(finding);
  const proposal = propose(draft, { actionType: input.actionType, reason });
  if (!proposal) throw new CopilotError("This finding cannot produce a strategy candidate.");

  const finalized = finding.recommendation && !["draft", "rejected", "expired"].includes(finding.recommendation.status);
  if (!finalized) editFinding(finding.id, input.actorId, input.actionType, reason);

  const db = getDb();
  const currentRecommendationId = finding.recommendation?.id || recommendationIdFor(finding.id);
  const last = db
    .prepare(`SELECT id, version_number FROM strategy_versions WHERE finding_id = ? AND recommendation_id = ? ORDER BY version_number DESC LIMIT 1`)
    .get(finding.id, currentRecommendationId) as { id: string; version_number: number } | undefined;
  const latestNumber = db
    .prepare(`SELECT MAX(version_number) AS version_number FROM strategy_versions WHERE finding_id = ?`)
    .get(finding.id) as { version_number: number | null };
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO strategy_versions (
      id, recommendation_id, finding_id, account_id, window_id, campaign_id, version_number,
      parent_version_id, conversation_id, message_id, proposal_json, source, actor_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    currentRecommendationId,
    finding.id,
    finding.accountId,
    finding.windowId,
    finding.campaignId,
    (latestNumber.version_number || 0) + 1,
    last?.id || null,
    input.conversationId || null,
    input.messageId || null,
    JSON.stringify(proposal),
    input.source || "human",
    input.actorId,
    now
  );
  return mapVersion(db.prepare(`SELECT * FROM strategy_versions WHERE id = ?`).get(id) as VersionRow);
}

function asDraft(finding: FindingView): FindingDraft {
  const { recommendation: _recommendation, stale: _stale, ...draft } = finding;
  return draft;
}

function mapVersion(row: VersionRow): StrategyVersion {
  return {
    id: row.id,
    recommendationId: row.recommendation_id,
    findingId: row.finding_id,
    accountId: row.account_id,
    windowId: row.window_id,
    campaignId: row.campaign_id,
    versionNumber: row.version_number,
    parentVersionId: row.parent_version_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    proposal: JSON.parse(row.proposal_json) as Proposal,
    source: row.source === "ai" ? "ai" : "human",
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

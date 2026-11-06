import { getDatasetMeta } from "@/lib/analytics";
import { getDb, nextId } from "@/lib/db";
import { englishProposalText, englishStoredProposal, englishWindowLabel, hasChinese, isLostEnglishCopy } from "./english-copy";
import { ACTION_LABEL } from "./labels";
import { compileInvestigationPacket, type InvestigationTrailStep, type PacketMessage } from "./investigation-packet";
import { defaultVerificationSteps } from "./recommend";
import { normalizeDecisionStatus } from "./status";
import { resolveWindow, scrubWindowCopy } from "./windows";
import type { ActionType } from "@/lib/analytics/types";
import type {
  DecisionView,
  FindingDraft,
  Proposal,
  RecommendationStatus,
  RecommendationView,
} from "./types";

function scrubStoredJson(raw: string | null | undefined) {
  return scrubWindowCopy(raw || "");
}

export class CopilotError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type StoredRecommendation = {
  id: string;
  finding_id: string;
  account_id: string;
  window_id: string;
  campaign_id: string;
  status: RecommendationStatus;
  user_edited: number;
  original_json: string;
  proposed_json: string;
  finding_json: string;
  created_at: string;
  updated_at: string;
  dataset_version: string | null;
};

type StoredDecision = {
  id: string;
  recommendation_id: string;
  status: RecommendationStatus;
  modified: number;
  diff_json: string;
  actor_id: string | null;
  confirmed_at: string | null;
  dismissed_at: string | null;
  exported_at: string | null;
  execution_mode: DecisionView["executionMode"];
  execution_result: string | null;
  observation_json: string | null;
  baseline_json: string | null;
  created_at: string;
  updated_at: string;
  conversation_id?: string | null;
  parent_decision_id?: string | null;
  notes_json?: string | null;
};

const ACTIVE = new Set<RecommendationStatus>(["confirmed"]);

export function recommendationIdFor(findingId: string) {
  const sourceVersion = getDatasetMeta().sourceSha256?.slice(0, 12);
  return sourceVersion ? `rec:${findingId}:${sourceVersion}` : `rec:${findingId}`;
}

export function decisionIdFor(recommendationId: string) {
  return `decision:${recommendationId}`;
}

export function listStoredRecommendations(accountId: string, windowId: string) {
  migrateLegacyDecisionStatuses();
  const rows = getDb()
    .prepare(
      `SELECT * FROM recommendations WHERE account_id = ? AND window_id = ? ORDER BY updated_at ASC`
    )
    .all(accountId, windowId) as StoredRecommendation[];
  return rows.map(mapRecommendation);
}

export function getStoredRecommendation(id: string) {
  migrateLegacyDecisionStatuses();
  const row = getDb().prepare(`SELECT * FROM recommendations WHERE id = ?`).get(id) as StoredRecommendation | undefined;
  return row ? mapRecommendation(row) : null;
}

export function overlayRecommendation(finding: FindingDraft, stored: RecommendationView | undefined, live: Proposal | null): RecommendationView | null {
  if (stored) return stored;
  if (!live) return stored || null;
  return {
    id: recommendationIdFor(finding.id),
    findingId: finding.id,
    status: "draft",
    userEdited: false,
    proposal: live,
    original: live,
    decisionId: null,
    updatedAt: null,
    datasetVersion: getDatasetMeta().datasetVersion,
    findingSnapshot: null,
  };
}

export function saveRecommendationEdit(input: {
  finding: FindingDraft;
  original: Proposal;
  proposal: Proposal;
  actorId: string;
  userEdited?: boolean;
}) {
  const id = recommendationIdFor(input.finding.id);
  const existing = getStoredRecommendation(id);
  if (existing && existing.status === "confirmed") {
    throw new CopilotError("A confirmed recommendation cannot be edited. Create a revision instead of changing the confirmed record.");
  }
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO recommendations (
      id, finding_id, account_id, window_id, campaign_id, status, user_edited, original_json, proposed_json, finding_json, created_at, updated_at, dataset_version
    ) VALUES (@id, @findingId, @accountId, @windowId, @campaignId, 'draft', @edited, @original, @proposed, @finding, @now, @now, @datasetVersion)
    ON CONFLICT(id) DO UPDATE SET
      status = 'draft',
      user_edited = excluded.user_edited,
      proposed_json = excluded.proposed_json,
      finding_json = excluded.finding_json,
      dataset_version = excluded.dataset_version,
      updated_at = excluded.updated_at`
  ).run({
    id,
    findingId: input.finding.id,
    accountId: input.finding.accountId,
    windowId: input.finding.windowId,
    campaignId: input.finding.campaignId,
    original: JSON.stringify(existing?.original || input.original),
    proposed: JSON.stringify(input.proposal),
    finding: JSON.stringify(input.finding),
    edited: input.userEdited === false ? 0 : 1,
    datasetVersion: getDatasetMeta().datasetVersion,
    now,
  });
  recordAudit(input.actorId, "edit", "recommendation", id, input.userEdited === false ? "Saved the current proposal draft" : "Edited proposal action or rationale");
  return getStoredRecommendation(id);
}

export function confirmRecommendation(input: { finding: FindingDraft; proposal: Proposal; original: Proposal; actorId: string }) {
  if (!input.proposal.guardrail.passed) throw new CopilotError("The recommendation has not passed validation and cannot be confirmed.");
  const id = recommendationIdFor(input.finding.id);
  const existing = getStoredRecommendation(id);
  if (existing?.status === "confirmed") {
    throw new CopilotError("This recommendation is already confirmed.");
  }
  const now = new Date().toISOString();
  const original = existing?.original || input.original;
  const diff = buildDiff(original, input.proposal);
  const decisionId = decisionIdFor(id);
  const baseline = {
    windowLabel: input.finding.windowLabel,
    campaignId: input.finding.campaignId,
    state: input.proposal.currentState,
    recordedAt: now,
  };
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO recommendations (
        id, finding_id, account_id, window_id, campaign_id, status, user_edited, original_json, proposed_json, finding_json, created_at, updated_at, dataset_version
      ) VALUES (@id, @findingId, @accountId, @windowId, @campaignId, 'confirmed', @edited, @original, @proposed, @finding, @now, @now, @datasetVersion)
      ON CONFLICT(id) DO UPDATE SET
        status = 'confirmed',
        proposed_json = excluded.proposed_json,
        finding_json = excluded.finding_json,
        dataset_version = excluded.dataset_version,
        updated_at = excluded.updated_at`
    ).run({
      id,
      findingId: input.finding.id,
      accountId: input.finding.accountId,
      windowId: input.finding.windowId,
      campaignId: input.finding.campaignId,
      edited: existing?.userEdited ? 1 : 0,
      original: JSON.stringify(original),
      proposed: JSON.stringify(input.proposal),
      finding: JSON.stringify(input.finding),
      datasetVersion: getDatasetMeta().datasetVersion,
      now,
    });
    db.prepare(
      `INSERT INTO decisions (
        id, recommendation_id, status, modified, diff_json, actor_id, confirmed_at, dismissed_at, exported_at, execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at
      ) VALUES (@id, @recommendationId, 'confirmed', @modified, @diff, @actorId, @now, NULL, NULL, NULL, NULL, NULL, @baseline, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        status = 'confirmed',
        modified = excluded.modified,
        diff_json = excluded.diff_json,
        actor_id = excluded.actor_id,
        confirmed_at = excluded.confirmed_at,
        dismissed_at = NULL,
        baseline_json = excluded.baseline_json,
        updated_at = excluded.updated_at`
    ).run({
      id: decisionId,
      recommendationId: id,
      modified: diff.length ? 1 : 0,
      diff: JSON.stringify(diff),
      actorId: input.actorId,
      baseline: JSON.stringify(baseline),
      now,
    });
    snapshotFinding(input.finding, now);
  });
  tx();
  recordAudit(input.actorId, "confirm", "decision", decisionId, "Confirmed the recommendation. Confirmation is not platform execution.");
  return getDecision(decisionId);
}

export function confirmDecision(id: string, actorId: string) {
  const decision = requireDecision(id);
  if (decision.status === "confirmed") throw new CopilotError("This decision is already confirmed.");
  const now = new Date().toISOString();
  const baseline = {
    windowLabel: decision.windowLabel,
    campaignId: decision.campaignId,
    state: decision.current.currentState,
    recordedAt: now,
  };
  const db = getDb();
  db.prepare(
    `UPDATE decisions
     SET status = 'confirmed', actor_id = ?, confirmed_at = ?, dismissed_at = NULL, baseline_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(actorId, now, JSON.stringify(baseline), now, id);
  db.prepare(`UPDATE recommendations SET status = 'confirmed', updated_at = ? WHERE id = ?`).run(now, decision.recommendationId);
  recordAudit(actorId, "confirm", "decision", id, "Confirmed the recommendation. Confirmation is not platform execution.");
  return getDecision(id);
}

type DecisionNotes = {
  verificationSteps?: string;
  userNotes?: string;
  dismissalReason?: string;
  investigationTrail?: InvestigationTrailStep[];
};

function mergeNotes(current: DecisionNotes | null | undefined, extra?: DecisionNotes): DecisionNotes {
  return {
    verificationSteps: extra?.verificationSteps ?? current?.verificationSteps ?? "",
    userNotes: extra?.userNotes ?? current?.userNotes ?? "",
    dismissalReason: extra?.dismissalReason ?? current?.dismissalReason ?? "",
    investigationTrail: extra?.investigationTrail ?? current?.investigationTrail ?? [],
  };
}

function conversationMessages(conversationId: string): PacketMessage[] {
  const rows = getDb()
    .prepare(`SELECT role, content, status, evidence_json FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conversationId) as Array<{ role: string; content: string | null; status: string; evidence_json: string | null }>;
  return rows.map((row) => {
    let tools: string[] = [];
    let reviewReady = false;
    if (row.evidence_json) {
      try {
        const parsed = JSON.parse(row.evidence_json) as { tools?: string[]; reviewReady?: boolean };
        tools = parsed.tools || [];
        reviewReady = reviewReady || Boolean(parsed.reviewReady);
      } catch {
        tools = [];
      }
    }
    return { role: row.role, content: row.content || "", status: row.status, tools, reviewReady };
  });
}

function packetForFinding(finding: FindingDraft, conversationId: string | null | undefined, proposal: Proposal | null | undefined) {
  return compileInvestigationPacket(
    {
      campaignName: finding.campaignName,
      title: `${finding.title || ""} ${proposal?.title || ""}`,
      findingType: finding.type,
      severity: finding.severity,
      evidence: finding.evidence || proposal?.evidence || [],
      conversationId: conversationId || null,
      windowId: finding.windowId,
      datasetVersion: getDatasetMeta().datasetVersion,
      actionType: proposal?.actionType,
    },
    conversationId ? conversationMessages(conversationId) : []
  );
}

export function dismissRecommendation(id: string, actorId: string, reason?: string | null) {
  const stored = requireRecommendation(id);
  if (stored.status === "confirmed") throw new CopilotError("A confirmed recommendation cannot be dismissed. Create a revision instead.");
  if (stored.status === "dismissed") throw new CopilotError("This recommendation is already dismissed.");
  const now = new Date().toISOString();
  const decisionId = decisionIdFor(id);
  const current = getDecision(decisionId);
  const notes = mergeNotes(current, { dismissalReason: (reason || "").trim() });
  const db = getDb();
  db.prepare(`UPDATE recommendations SET status = 'dismissed', updated_at = ? WHERE id = ?`).run(now, id);
  db.prepare(
    `INSERT INTO decisions (
      id, recommendation_id, status, modified, diff_json, actor_id, confirmed_at, dismissed_at, exported_at, execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at, notes_json
    ) VALUES (?, ?, 'dismissed', 0, '[]', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = 'dismissed', actor_id = excluded.actor_id, dismissed_at = excluded.dismissed_at, notes_json = excluded.notes_json, updated_at = excluded.updated_at`
  ).run(decisionId, id, actorId, now, now, now, JSON.stringify(notes));
  recordAudit(actorId, "dismiss", "decision", decisionId, "Dismissed the recommendation. No platform change was made.");
  return getDecision(decisionId);
}

export function dismissDecision(id: string, actorId: string, reason?: string | null) {
  const decision = requireDecision(id);
  if (decision.status === "confirmed") {
    throw new CopilotError("A confirmed decision cannot be dismissed. Create a revision if the recommendation needs to change.");
  }
  return dismissRecommendation(decision.recommendationId, actorId, reason);
}

export function compileInvestigationReason(conversationId?: string | null) {
  if (!conversationId) return null;
  return compileInvestigationPacket({ campaignName: "This campaign", conversationId }, conversationMessages(conversationId)).reason;
}

export function ensureDraftDecision(input: {
  finding: FindingDraft;
  original: Proposal;
  proposal: Proposal;
  actorId: string;
  conversationId?: string | null;
  userEdited?: boolean;
}) {
  let recId = recommendationIdFor(input.finding.id);
  let existing = getStoredRecommendation(recId);
  let decisionId = decisionIdFor(recId);
  let current = getDecision(decisionId);
  const now = new Date().toISOString();
  if (current?.status === "draft") {
    if (input.conversationId && !current.conversationId) {
      getDb().prepare(`UPDATE decisions SET conversation_id = ?, updated_at = ? WHERE id = ?`).run(input.conversationId, now, decisionId);
    }
    return getDecision(decisionId);
  }
  if (current) {
    recId = `${recId}:open:${Date.now()}`;
    existing = null;
    decisionId = decisionIdFor(recId);
    current = null;
  }
  const packet = existing?.userEdited ? null : packetForFinding(input.finding, input.conversationId, existing?.proposal || input.proposal);
  const proposal = packet
    ? { ...(existing?.proposal || input.proposal), title: packet.title, reason: packet.reason }
    : existing?.proposal || input.proposal;
  if (existing && existing.status === "draft") {
    saveRecommendationEdit({
      finding: input.finding,
      original: existing.original || input.original,
      proposal,
      actorId: input.actorId,
      userEdited: input.userEdited ?? existing.userEdited ?? false,
    });
  } else {
    getDb()
      .prepare(
        `INSERT INTO recommendations (
          id, finding_id, account_id, window_id, campaign_id, status, user_edited, original_json, proposed_json, finding_json, created_at, updated_at, dataset_version
        ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        recId,
        input.finding.id,
        input.finding.accountId,
        input.finding.windowId,
        input.finding.campaignId,
        input.userEdited === false ? 0 : 0,
        JSON.stringify(existing?.original || input.original),
        JSON.stringify(proposal),
        JSON.stringify(input.finding),
        now,
        now,
        getDatasetMeta().datasetVersion
      );
  }
  const notes = mergeNotes(null, {
    verificationSteps: packet?.verificationSteps.join("\n") || defaultVerificationSteps(input.finding),
    userNotes: "",
    investigationTrail: packet?.trail || [],
  });
  getDb()
    .prepare(
      `INSERT INTO decisions (
        id, recommendation_id, status, modified, diff_json, actor_id, confirmed_at, dismissed_at, exported_at,
        execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at,
        conversation_id, parent_decision_id, notes_json
      ) VALUES (?, ?, 'draft', 0, '[]', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, ?)`
    )
    .run(decisionId, recId, input.actorId, now, now, input.conversationId || null, JSON.stringify(notes));
  recordAudit(input.actorId, "draft", "decision", decisionId, "Opened a review decision draft. No platform change was made.");
  return getDecision(decisionId);
}

export function updateDraftDecision(input: {
  id: string;
  actorId: string;
  title?: string;
  reason?: string;
  verificationSteps?: string;
  userNotes?: string;
}) {
  const decision = requireDecision(input.id);
  if (decision.status !== "draft") {
    throw new CopilotError("Only a draft decision can be edited.");
  }
  const rec = requireRecommendation(decision.recommendationId);
  const now = new Date().toISOString();
  const proposal = {
    ...rec.proposal,
    title: input.title?.trim() || rec.proposal.title,
    reason: input.reason?.trim() || rec.proposal.reason,
  };
  const original = rec.original;
  const diff = buildDiff(original, proposal);
  const notes = mergeNotes(decision, {
    verificationSteps: input.verificationSteps ?? decision.verificationSteps,
    userNotes: input.userNotes ?? decision.userNotes,
  });
  const db = getDb();
  db.prepare(
    `UPDATE recommendations SET user_edited = 1, proposed_json = ?, updated_at = ? WHERE id = ?`
  ).run(JSON.stringify(proposal), now, rec.id);
  db.prepare(
    `UPDATE decisions SET modified = ?, diff_json = ?, notes_json = ?, updated_at = ? WHERE id = ?`
  ).run(diff.length ? 1 : 0, JSON.stringify(diff), JSON.stringify(notes), now, decision.id);
  recordAudit(input.actorId, "edit", "decision", decision.id, "Edited the draft recommendation. Original evidence was left unchanged.");
  return getDecision(decision.id);
}

export function createRevisionDecision(id: string, actorId: string) {
  const parent = requireDecision(id);
  if (parent.status !== "confirmed") {
    throw new CopilotError("Only a confirmed decision can be revised.");
  }
  const openRevision = getDb()
    .prepare(`SELECT id FROM decisions WHERE parent_decision_id = ? AND status = 'draft' ORDER BY created_at DESC`)
    .get(parent.id) as { id: string } | undefined;
  if (openRevision) return requireDecision(openRevision.id);
  const rec = requireRecommendation(parent.recommendationId);
  const finding = rec.findingSnapshot;
  if (!finding) throw new CopilotError("The original finding snapshot is missing for this decision.");
  const now = new Date().toISOString();
  const recId = `${recommendationIdFor(finding.id)}:rev:${Date.now()}`;
  const decisionId = decisionIdFor(recId);
  const notes = {
    verificationSteps: parent.verificationSteps || defaultVerificationSteps(finding),
    userNotes: "",
  };
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO recommendations (
        id, finding_id, account_id, window_id, campaign_id, status, user_edited, original_json, proposed_json, finding_json, created_at, updated_at, dataset_version
      ) VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?, ?, ?, ?)`
    ).run(
      recId,
      finding.id,
      finding.accountId,
      finding.windowId,
      finding.campaignId,
      JSON.stringify(rec.original),
      JSON.stringify(rec.proposal),
      JSON.stringify(finding),
      now,
      now,
      rec.datasetVersion
    );
    db.prepare(
      `INSERT INTO decisions (
        id, recommendation_id, status, modified, diff_json, actor_id, confirmed_at, dismissed_at, exported_at,
        execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at,
        conversation_id, parent_decision_id, notes_json
      ) VALUES (?, ?, 'draft', 0, '[]', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`
    ).run(decisionId, recId, actorId, now, now, parent.conversationId, parent.id, JSON.stringify(notes));
  });
  tx();
  recordAudit(actorId, "revise", "decision", decisionId, `Opened a revision of ${parent.id}. The confirmed record was left unchanged.`);
  return getDecision(decisionId);
}

export function exportDecision(id: string, actorId: string) {
  const decision = requireDecision(id);
  if (decision.status !== "confirmed") {
    throw new CopilotError("Confirm the decision before exporting a record.");
  }
  const document = renderDocument(decision);
  const now = new Date().toISOString();
  const observation = waitingObservation(decision);
  getDb()
    .prepare(
      `UPDATE decisions
       SET execution_mode = 'export', execution_result = ?, observation_json = ?, exported_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(document, JSON.stringify(observation), now, now, id);
  recordAudit(actorId, "export", "decision", id, "Exported decision record. This is not platform execution.");
  return { decision: getDecision(id), document };
}

export function listDecisions(status?: RecommendationStatus | "all") {
  migrateLegacyDecisionStatuses();
  const rows = getDb()
    .prepare(`SELECT * FROM decisions ORDER BY updated_at DESC LIMIT 200`)
    .all() as StoredDecision[];
  const views = rows.map(hydrateDecision).filter((item): item is DecisionView => Boolean(item));
  if (!status || status === "all") return views;
  return views.filter((item) => item.status === status);
}

export function getDecision(id: string) {
  migrateLegacyDecisionStatuses();
  const row = getDb().prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as StoredDecision | undefined;
  if (!row) return null;
  return hydrateDecision(row);
}

export function countDraftDecisions() {
  migrateLegacyDecisionStatuses();
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM decisions WHERE status = 'draft'`).get() as { count: number };
  return Number(row?.count || 0);
}

export const countPendingDecisions = countDraftDecisions;

export function snapshotFindings(findings: FindingDraft[]) {
  const now = new Date().toISOString();
  const db = getDb();
  const tx = db.transaction(() => {
    for (const finding of findings) snapshotFinding(finding, now);
  });
  tx();
}

function snapshotFinding(finding: FindingDraft, now: string) {
  getDb()
    .prepare(
      `INSERT INTO findings (id, account_id, window_id, campaign_id, finding_type, severity, payload, created_at, updated_at)
       VALUES (@id, @accountId, @windowId, @campaignId, @type, @severity, @payload, @now, @now)
       ON CONFLICT(id) DO UPDATE SET severity = excluded.severity, payload = excluded.payload, updated_at = excluded.updated_at`
    )
    .run({
      id: finding.id,
      accountId: finding.accountId,
      windowId: finding.windowId,
      campaignId: finding.campaignId,
      type: finding.type,
      severity: finding.severity,
      payload: JSON.stringify(finding),
      now,
    });
}

function migrateLegacyDecisionStatuses() {
  const db = getDb();
  db.exec(`
    UPDATE decisions SET exported_at = COALESCE(exported_at, updated_at) WHERE (status = 'exported' OR execution_mode = 'export') AND exported_at IS NULL;
    UPDATE recommendations SET status = 'confirmed' WHERE status IN ('approved', 'exported', 'externally_marked');
    UPDATE recommendations SET status = 'dismissed' WHERE status = 'rejected';
    UPDATE recommendations SET status = 'draft' WHERE status IN ('pending_review', 'expired');
    UPDATE decisions SET status = 'confirmed' WHERE status IN ('approved', 'exported', 'externally_marked');
    UPDATE decisions SET status = 'dismissed' WHERE status = 'rejected';
    UPDATE decisions SET status = 'draft' WHERE status IN ('pending_review', 'expired');
  `);
}

function requireRecommendation(id: string) {
  const stored = getStoredRecommendation(id);
  if (!stored) throw new CopilotError("No proposal record to act on. Edit or submit first.", 404);
  return stored;
}

function requireDecision(id: string) {
  const decision = getDecision(id);
  if (!decision) throw new CopilotError("Decision not found.", 404);
  return decision;
}

function mapRecommendation(row: StoredRecommendation): RecommendationView {
  const decision = getDb().prepare(`SELECT id, status FROM decisions WHERE recommendation_id = ?`).get(row.id) as { id: string; status: string } | undefined;
  return {
    id: row.id,
    findingId: row.finding_id,
    status: normalizeDecisionStatus(row.status),
    userEdited: Boolean(row.user_edited),
    proposal: englishStoredProposal(parseJson<Proposal>(scrubStoredJson(row.proposed_json))),
    original: englishStoredProposal(parseJson<Proposal>(scrubStoredJson(row.original_json))),
    decisionId: decision?.id || null,
    updatedAt: row.updated_at,
    datasetVersion: row.dataset_version || null,
    findingSnapshot: parseJson<FindingDraft | null>(scrubStoredJson(row.finding_json || "null"), null),
  };
}

function hydrateDecision(row: StoredDecision): DecisionView | null {
  const recommendation = getDb().prepare(`SELECT * FROM recommendations WHERE id = ?`).get(row.recommendation_id) as StoredRecommendation | undefined;
  if (!recommendation) return null;
  const finding = parseJson<FindingDraft>(scrubStoredJson(recommendation.finding_json));
  const current = parseJson<Proposal>(scrubStoredJson(recommendation.proposed_json));
  const original = parseJson<Proposal>(scrubStoredJson(recommendation.original_json));
  const auditRows = getDb()
    .prepare(`SELECT * FROM audit_events WHERE entity_id = ? OR entity_id = ? ORDER BY created_at DESC LIMIT 12`)
    .all(row.id, row.recommendation_id) as Array<{ id: string; actor_id: string; action: string; detail: string; created_at: string }>;
  const status = normalizeDecisionStatus(row.status);
  const confirmedAt = status === "confirmed" ? row.confirmed_at : null;
  const dismissedAt = status === "dismissed" ? row.dismissed_at : null;
  const exportedAt = row.exported_at || (row.execution_mode === "export" ? row.updated_at : null);
  const notes = parseJson<DecisionNotes | null>(row.notes_json ?? null, {}) || {};
  const timelineNote =
    confirmedAt && Date.parse(confirmedAt) < Date.parse(row.created_at)
      ? "Confirmation time is earlier than the record's created time. Original timestamps were kept."
      : null;
  return {
    id: row.id,
    recommendationId: row.recommendation_id,
    findingId: recommendation.finding_id,
    status,
    campaignId: recommendation.campaign_id,
    campaignName: finding.campaignName,
    title: englishStoredProposal(current).title || current.title,
    modified: Boolean(row.modified),
    diff: parseJson<DecisionView["diff"]>(row.diff_json, []),
    original: englishStoredProposal(original),
    current: englishStoredProposal(current),
    actorId: row.actor_id,
    actorName: actorDisplayName(row.actor_id),
    confirmedAt,
    dismissedAt,
    exportedAt,
    executionMode: row.execution_mode,
    executionResult: row.execution_result,
    observation: englishObservation(parseJson<DecisionView["observation"]>(row.observation_json, null)),
    baselineLabel: englishProposalText(parseJson<{ state?: string } | null>(row.baseline_json, null)?.state || null) || null,
    windowLabel: recoveredWindow(finding.windowLabel, recommendation.window_id || finding.windowId, "label"),
    windowId: recommendation.window_id || finding.windowId || null,
    datasetVersion: recommendation.dataset_version || null,
    compareLabel: recoveredWindow(finding.compareLabel, recommendation.window_id || finding.windowId, "compare"),
    findingType: finding.type || null,
    severity: finding.severity || null,
    conversationId: row.conversation_id || null,
    parentDecisionId: row.parent_decision_id || null,
    verificationSteps: notes.verificationSteps || "",
    userNotes: notes.userNotes || "",
    dismissalReason: notes.dismissalReason || "",
    investigationTrail: notes.investigationTrail || [],
    timelineNote,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    highRisk: current.riskLevel === "high" || current.actionType === "pause_candidate" || current.actionType === "decrease_priority",
    findingRaw: finding.raw || null,
    audit: auditRows.map((event) => ({
      id: event.id,
      actorId: event.actor_id,
      actorName: actorDisplayName(event.actor_id) || "User",
      action: event.action,
      createdAt: event.created_at,
      detail: englishProposalText(event.detail) || event.detail,
    })),
  };
}

function buildDiff(original: Proposal, proposed: Proposal) {
  const diff: DecisionView["diff"] = [];
  if (original.actionType !== proposed.actionType) {
    diff.push({ label: "Action", before: ACTION_LABEL[original.actionType], after: ACTION_LABEL[proposed.actionType] });
  }
  if (original.reason !== proposed.reason) diff.push({ label: "Rationale", before: original.reason, after: proposed.reason });
  return diff;
}

const EVIDENCE_LABELS: Record<string, string> = {
  曝光: "Impressions",
  点击: "Clicks",
  转化: "Conversion-linked clicks",
  转化关联点击: "Conversion-linked clicks",
  点击后转化率: "Conversion-link rate",
  点击后转化关联率: "Conversion-link rate",
  成本指数: "Cost index",
  成本指数总值: "Cost index total",
  单次点击成本指数: "Average cost index per click",
};

function englishEvidenceLabel(value: string) {
  return EVIDENCE_LABELS[value] || (hasChinese(value) ? "Verified metric" : value);
}

function recoveredWindow(value: string | null | undefined, windowId: string | null | undefined, kind: "label"): string;
function recoveredWindow(value: string | null | undefined, windowId: string | null | undefined, kind: "compare"): string | null;
function recoveredWindow(value: string | null | undefined, windowId: string | null | undefined, kind: "label" | "compare") {
  const cleaned = englishWindowLabel(value) || (value && !isLostEnglishCopy(value) && !hasChinese(value) ? value : "");
  if (cleaned) return cleaned;
  const resolved = resolveWindow(windowId, getDatasetMeta());
  if (!resolved) return kind === "label" ? value || "" : value || null;
  return kind === "label" ? resolved.label : resolved.compareLabel;
}

function englishObservation(value: DecisionView["observation"]) {
  if (!value) return null;
  return {
    ...value,
    baselineLabel: englishProposalText(value.baselineLabel) || value.baselineLabel,
    note: englishProposalText(value.note) || value.note,
  };
}

function waitingObservation(decision: DecisionView): DecisionView["observation"] {
  return {
    state: "waiting_for_new_sync",
    baselineLabel: decision.baselineLabel || decision.current.currentState,
    note: "The confirmation-time baseline is recorded. No newer dataset exists, so the current window cannot be presented as an outcome caused by this action.",
  };
}

function renderDocument(decision: DecisionView) {
  const action = ACTION_LABEL[decision.current.actionType];
  return [
    "AdPilot decision record",
    "This file records a user-confirmed investigation recommendation. Export is not platform execution.",
    `Campaign: ${decision.campaignName}`,
    `Window: ${englishWindowLabel(decision.windowLabel) || decision.windowLabel}`,
    `Action: ${action}`,
    `Observed state: ${englishProposalText(decision.current.currentState, decision.current.actionType)}`,
    `Proposal: ${englishProposalText(decision.current.proposedState, decision.current.actionType)}`,
    `Decision ID: ${decision.id}`,
    `Status: ${decision.status}`,
    `Rationale: ${englishProposalText(decision.current.reason, decision.current.actionType)}`,
    `Risk: ${englishProposalText(decision.current.riskNote, decision.current.actionType)}`,
    `Evidence level: ${decision.current.evidenceLevel}`,
    ...decision.current.evidence.slice(0, 8).map((item) => `Evidence ${englishEvidenceLabel(item.label)}: ${item.value}${item.baseline ? ` (prior ${item.baseline})` : ""}${item.delta ? ` ${item.delta}` : ""}`),
    decision.modified ? "The proposal was materially changed from the original." : "The proposal matches the original AI draft.",
    "No advertising-platform write integration is available, so AdPilot does not apply this plan.",
  ].join("\n");
}

export function recordAudit(actorId: string, action: string, entityType: string, entityId: string, detail: string) {
  getDb()
    .prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nextId(), actorId, action, entityType, entityId, detail, new Date().toISOString());
}

function parseJson<T>(value: string | null, fallback?: T): T {
  if (!value) return fallback as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback as T;
  }
}

export function storedFinding(rowFindingJson: string) {
  return parseJson<FindingDraft>(rowFindingJson);
}

function actorDisplayName(id: string | null | undefined) {
  if (!id) return null;
  if (id === "system") return "System";
  const row = getDb().prepare(`SELECT name FROM actors WHERE id = ?`).get(id) as { name: string } | undefined;
  return row?.name || "User";
}

export function isActiveStatus(status: RecommendationStatus) {
  return ACTIVE.has(status);
}

export function actionAllowed(value: string): value is ActionType {
  return ["increase_priority", "decrease_priority", "hold", "review", "pause_candidate"].includes(value);
}

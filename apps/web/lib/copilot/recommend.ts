import type { ActionType } from "@/lib/analytics/types";
import { validateStrategy } from "@/lib/guardrails";
import { simulateStrategy } from "@/lib/simulation";
import type { Strategy } from "@/lib/types";
import { ACTION_LABEL, EVIDENCE_LABEL, formatChange, formatCount, formatRate } from "./labels";
import type { EvidenceLevel, FindingDraft, Proposal, RiskLevel } from "./types";

const EFFECT_NOTE = "No reliable outcome estimate is available. Offline weighting only compares directions in historical logs; it is not a forecast of platform results.";
const COMPARISON_NOTE = "This offline weighting uses historical logs for directional comparison only; it is not a forecast of platform results.";

export function propose(finding: FindingDraft, override?: { actionType?: ActionType; reason?: string }): Proposal | null {
  if (finding.type === "data_gap" || finding.severity === "info") return null;
  const action = override?.actionType || chooseAction(finding);
  const reason = (override?.reason || defaultReason(finding)).trim();
  const first = assemble(finding, action, reason);
  if (first.guardrail.passed || action === "review") return first;
  const fallback = assemble(finding, "review", `${reason} The original action did not pass the guardrail, so it was changed to manual review.`);
  fallback.guardrail.warnings = [...fallback.guardrail.warnings, "The original action did not pass the guardrail and was changed to manual review."];
  return fallback;
}

export function chooseAction(finding: FindingDraft): ActionType {
  // The public Criteo snapshot can justify a human validation task, but it has
  // no budget, bid, delivery, or causal fields that support automatic scaling,
  // deprioritization, or pausing.
  if (finding.type === "scale_opportunity" || finding.type === "cvr_anomaly") return "review";
  return "review";
}

function defaultReason(finding: FindingDraft) {
  return `${finding.fact}${finding.interpretation}`;
}

export function defaultVerificationSteps(finding: FindingDraft) {
  const window = finding.windowLabel || "the selected window";
  const name = finding.campaignName;
  if (finding.type === "scale_opportunity") {
    return [
      `First confirm whether ${name}'s conversion-link improvement in ${window} holds across days.`,
      "Then check creative, landing page, audience, budget, and bids in the advertising platform. Those fields are not in this snapshot.",
      "Only after the improvement is verified outside this log should delivery or budget be considered.",
    ].join("\n");
  }
  return [
    `First check whether ${name} had creative, landing-page, or audience changes in ${window}. Those fields are not in this snapshot.`,
    "Then inspect budget, bids, and delivery structure for the same window.",
    "Only after tracking, attribution-window, and measurement issues are ruled out, consider a delivery change.",
  ].join("\n");
}

function assemble(finding: FindingDraft, action: ActionType, reason: string): Proposal {
  const evidenceLevel = levelFor(finding);
  const riskLevel = riskFor(action);
  const guarded = guard(finding, action, reason, evidenceLevel);
  return {
    title: proposalTitle(finding, action),
    actionType: action,
    reason,
    currentState: `No budget or bid field is available. Verified observation: ${formatCount(finding.raw.clicks)} clicks, ${formatRate(finding.raw.cvr)} post-click conversion-link rate, ${formatChange(finding.raw.cvrChangePct)} versus the prior window.`,
    proposedState: `Proposed action: ${ACTION_LABEL[action]}. Confirmation still requires an export or an external platform action; AdPilot does not change campaign delivery directly.`,
    impact: `Scope is limited to ${finding.campaignName}.`,
    riskLevel,
    riskNote: riskNote(action, finding),
    evidenceLevel,
    evidence: finding.evidence,
    guardrail: guarded,
    offlineComparison: comparison(finding.campaignId, action),
    expectedEffect: null,
    expectedEffectNote: EFFECT_NOTE,
  };
}

function proposalTitle(finding: FindingDraft, action: ActionType) {
  if (action !== "review") return `${finding.campaignName}: ${ACTION_LABEL[action]}`;
  if (finding.type === "cvr_anomaly") return `${finding.campaignName}: Verify setup before changing delivery`;
  if (finding.type === "scale_opportunity") return `${finding.campaignName}: Validate observed conversion-link improvement`;
  if (finding.type === "cost_rise") return `${finding.campaignName}: Review cost-index increase`;
  if (finding.type === "attribution_anomaly") return `${finding.campaignName}: Review attribution change`;
  return `${finding.campaignName}: Review verified performance signal`;
}

function levelFor(finding: FindingDraft): EvidenceLevel {
  const previous = finding.raw.previousClicks ?? 0;
  if (finding.raw.clicks >= 500 && previous >= 500 && finding.severity === "high") return "sufficient";
  if (finding.raw.clicks >= 80 && previous >= 80) return "limited";
  return "insufficient";
}

function riskFor(action: ActionType): RiskLevel {
  if (action === "pause_candidate" || action === "decrease_priority") return "high";
  if (action === "increase_priority") return "medium";
  return "low";
}

function riskNote(action: ActionType, finding: FindingDraft) {
  if (action === "pause_candidate") {
    return `${finding.campaignName} will be marked for review before pausing. This is not an executed pause, and no platform pause integration is available.`;
  }
  if (action === "decrease_priority") return "Lower priority may reduce future delivery. The available data cannot estimate the amount.";
  if (action === "increase_priority") return "Higher priority may direct more traffic to this campaign. The available data cannot estimate the increment.";
  return "Manual review does not change campaign delivery.";
}

function guard(finding: FindingDraft, action: ActionType, reason: string, evidenceLevel: EvidenceLevel) {
  const errors: string[] = [];
  const confidence = evidenceLevel === "sufficient" ? 0.8 : evidenceLevel === "limited" ? 0.66 : 0.5;
  if (/预算|出价|ROAS|CPA|素材疲劳|节省/.test(reason) && !/没有|不能|不可|未提供|不是/.test(reason)) {
    errors.push("The rationale cannot present unavailable fields as verified causes or outcomes.");
  }
  const strategy: Strategy = {
    id: null,
    title: `${finding.campaignName} ${ACTION_LABEL[action]}`,
    summary: reason,
    targetCampaigns: [finding.campaignId],
    evidence: [{ campaignId: finding.campaignId, facts: [finding.fact, finding.interpretation, finding.hypothesis], metrics: {} }],
    actions: [{ campaignId: finding.campaignId, actionType: action, reason, percentage: null }],
    risks: [riskNote(action, finding), `${EVIDENCE_LABEL[evidenceLevel]}.`],
    confidence,
  };
  const result = validateStrategy(strategy);
  return { passed: result.passed && errors.length === 0, errors: [...errors, ...result.errors], warnings: result.warnings };
}

function comparison(campaignId: string, action: ActionType): Proposal["offlineComparison"] {
  if (action === "review" || action === "hold") return null;
  const simulation = simulateStrategy([{ campaignId, actionType: action, reason: ACTION_LABEL[action], percentage: null }]);
  const effect = simulation.actionEffects.find((item) => item.campaignId === campaignId);
  if (!effect || effect.weight === 1) return null;
  return {
    weight: effect.weight,
    baselineScore: effect.baseline.score,
    comparedScore: effect.strategy.score,
    disclaimer: COMPARISON_NOTE,
  };
}

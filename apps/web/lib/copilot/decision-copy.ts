import type { DecisionView, EvidenceItem } from "./types";
import { englishProposalText } from "./english-copy";
import { FINDING_LABEL, SEVERITY_LABEL } from "./labels";
import { compileInvestigationPacket } from "./investigation-packet";
import { metricCards, recordedMetrics, recommendationNumbersMatchEvidence } from "./metrics";

export type InvestigationHint = {
  role?: string;
  content?: string;
  tools?: string[];
  status?: string;
};

export type DecisionCopy = {
  title: string;
  action: string;
  rationale: string;
  unverifiedLead: string;
  unverifiedItems: string[];
  status: string;
  legacy: boolean;
  originalRecorded: string | null;
  recordedTitle: string | null;
  listSignal: string;
  evidenceMismatch: boolean;
};

export function decisionCopy(decision: DecisionView, investigation: InvestigationHint[] = []): DecisionCopy {
  const packet = compileInvestigationPacket(
    {
      campaignName: decision.campaignName,
      title: `${decision.title || ""} ${decision.current.title || ""}`,
      findingType: decision.findingType,
      severity: decision.severity,
      evidence: decision.current.evidence || [],
      conversationId: decision.conversationId,
      windowId: decision.windowId,
      windowLabel: decision.windowLabel,
      datasetVersion: decision.datasetVersion,
      actionType: decision.current.actionType,
    },
    investigation
  );
  const generatedAction = packet.action;
  const generatedRationale = packet.reason;
  const storedSteps = decision.verificationSteps?.trim()
    ? decision.verificationSteps.split(/\n+/).map((item) => item.trim()).filter(Boolean)
    : [];
  const unverifiedItems = (decision.modified && storedSteps.length ? storedSteps : packet.verificationSteps).slice(0, 3);
  const legacy = isLegacyRecommendation(decision);
  const storedTitle = decision.current.title || decision.original?.title || decision.title || "";
  const recordedTitle = englishProposalText(storedTitle, decision.current.actionType) || storedTitle || null;
  const useStored = shouldUseStoredCopy(decision);
  const action = decision.modified && storedTitle.trim()
    ? compactSentence(englishProposalText(storedTitle, decision.current.actionType) || generatedAction)
    : generatedAction;
  const rationale = useStored ? compactParagraph(decision.current.reason) : generatedRationale;
  const metrics = recordedMetrics(decision.findingRaw, decision.current.evidence || []);
  return {
    title: action,
    action,
    rationale,
    unverifiedLead: "",
    unverifiedItems,
    status: statusCopy(decision),
    legacy,
    originalRecorded: legacy ? englishProposalText(decision.current.reason, decision.current.actionType) || null : null,
    recordedTitle: recordedTitle && recordedTitle !== action ? recordedTitle : storedTitle && storedTitle !== action ? storedTitle : null,
    listSignal: decision.findingType ? FINDING_LABEL[decision.findingType] : compactSentence(action),
    evidenceMismatch: Boolean(rationale) && !recommendationNumbersMatchEvidence(rationale, metrics),
  };
}

function shouldUseStoredCopy(decision: DecisionView) {
  if (isLegacyRecommendation(decision)) return false;
  const reason = decision.current.reason?.trim() || "";
  if (!reason) return false;
  if (reason.length < 80 && !/\d+(?:\.\d+)?\s*%/.test(reason) && !decision.modified) return false;
  return true;
}

export function keyMetrics(decision: DecisionView) {
  if (decision.findingType === "cost_rise") {
    const evidence = decision.current.evidence;
    const cost = findEvidence(evidence, ["cost index", "成本指数"]);
    const clicks = findEvidence(evidence, ["clicks", "点击"]);
    return [
      metricCard("Cost index", cost),
      relativeCard(cost),
      metricCard("Clicks", clicks),
    ].filter(Boolean) as Array<{ label: string; value: string; detail?: string }>;
  }
  return metricCards(recordedMetrics(decision.findingRaw, decision.current.evidence || []));
}

function metricCard(label: string, item: EvidenceItem | undefined) {
  if (!item?.value) return null;
  return {
    label,
    value: item.value,
    detail: item.baseline ? `vs ${item.baseline}` : undefined,
  };
}

function relativeCard(item: EvidenceItem | undefined) {
  if (!item) return null;
  const points = pointChange(item);
  const relative = item.delta?.trim() || null;
  if (!relative && !points) return null;
  return {
    label: "Relative change",
    value: relative || points || "—",
    detail: relative && points && relative !== points ? points : undefined,
  };
}

function pointChange(item: EvidenceItem) {
  const current = parseNumber(item.value);
  const previous = parseNumber(item.baseline);
  if (current == null || previous == null) return null;
  const delta = current - previous;
  const suffix = /%/.test(item.value) ? " pp" : "";
  const signed = `${delta > 0 ? "+" : ""}${delta.toFixed(2)}${suffix}`;
  return signed;
}

function parseNumber(value: string | null | undefined) {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function findEvidence(evidence: EvidenceItem[], labels: string[]) {
  return evidence.find((item) => {
    const label = item.label.toLowerCase();
    return labels.some((needle) => label === needle || label.includes(needle));
  });
}

export function isLegacyRecommendation(decision: Pick<DecisionView, "current">) {
  const reason = decision.current.reason || "";
  const title = decision.current.title || "";
  return hasChinese(reason) || hasChinese(title) || /样本足够/.test(reason) || decision.current.actionType === "increase_priority" || decision.current.actionType === "decrease_priority";
}

export function decisionEventAt(decision: Pick<DecisionView, "status" | "createdAt" | "updatedAt" | "confirmedAt" | "dismissedAt">) {
  if (decision.status === "confirmed" && decision.confirmedAt) return decision.confirmedAt;
  if (decision.status === "dismissed" && decision.dismissedAt) return decision.dismissedAt;
  return decision.updatedAt || decision.createdAt;
}

function statusCopy(decision: DecisionView) {
  if (decision.status === "draft") return "Draft";
  if (decision.status === "confirmed") {
    const confirmedAt = decision.confirmedAt
      ? ` on ${new Date(decision.confirmedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
      : "";
    return `Confirmed by User${confirmedAt}`;
  }
  if (decision.status === "dismissed") {
    const dismissedAt = decision.dismissedAt
      ? ` on ${new Date(decision.dismissedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
      : "";
    return `Dismissed by User${dismissedAt}`;
  }
  return "Draft";
}

function compactSentence(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function compactParagraph(value: string) {
  return compactSentence(value).split(/(?<=[.!?])\s+/).slice(0, 3).join(" ");
}

function hasChinese(value: string) {
  return /[\u3400-\u9fff]/.test(value);
}

export function severityLabel(decision: DecisionView) {
  return decision.severity ? SEVERITY_LABEL[decision.severity] : null;
}

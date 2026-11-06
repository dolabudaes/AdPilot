import type { ActionType } from "@/lib/analytics/types";
import { compact, pct, signedPct } from "@/lib/workbench/format";
import type { EvidenceLevel, FindingType, FindingView, RecommendationStatus, RiskLevel, Role, Severity } from "./types";

export const ACTION_LABEL: Record<ActionType, string> = {
  increase_priority: "Increase priority",
  decrease_priority: "Decrease priority",
  hold: "Continue monitoring",
  review: "Manual review",
  pause_candidate: "Review before pausing",
};

export const FINDING_LABEL: Record<FindingType, string> = {
  cvr_anomaly: "Conversion-link rate decline",
  weak_click_efficiency: "Weak click conversion-link",
  cost_rise: "Cost index increase",
  scale_opportunity: "Conversion-link rate improvement",
  attribution_anomaly: "Attribution anomaly",
  data_gap: "Insufficient data",
};

export const METRIC_HINT: Record<string, string> = {
  clicks: "Clicks in the selected analysis window.",
  conversions: "Clicks that received a future 30-day conversion label in this log snapshot. Not confirmed purchases or revenue.",
  cvr: "Share of clicks with a future 30-day conversion label in this window. Not live platform CVR, attributed ROI, or full-account conversion rate.",
  attributed: "Log-attributed conversion links in this snapshot, not a commercial attribution report.",
  cost: "Log cost index, not verified spend or budget.",
  ctr: "Clicks / impressions in this log sample.",
  impressions: "Impressions in this log sample, not a complete commercial delivery report.",
};

export type SignalKind = "decline" | "weak" | "opportunity" | "info";

export function signalKind(type: FindingType): { id: SignalKind; label: string } {
  if (type === "cvr_anomaly" || type === "cost_rise") return { id: "decline", label: "Decline" };
  if (type === "weak_click_efficiency") return { id: "weak", label: "Weak efficiency" };
  if (type === "scale_opportunity") return { id: "opportunity", label: "Opportunity" };
  return { id: "info", label: "Informational" };
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

export const STATUS_LABEL: Record<RecommendationStatus, string> = {
  draft: "Draft",
  confirmed: "Confirmed",
  dismissed: "Dismissed",
};

export const RISK_LABEL: Record<RiskLevel, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const EVIDENCE_LABEL: Record<EvidenceLevel, string> = {
  sufficient: "Sufficient evidence",
  limited: "Limited evidence",
  insufficient: "Insufficient evidence",
};

export const ROLE_LABEL: Record<Role, string> = {
  user: "User",
};

export function formatCount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatRate(value: number | null | undefined) {
  return pct(value, 2);
}

export function formatChange(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "No comparison";
  return signedPct(value, 1);
}

export function formatCost(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const n = value;
  if (n !== 0 && Math.abs(n) < 1) {
    return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(n);
  }
  if (Math.abs(n) < 10_000) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(n);
  }
  return compact(value, 2);
}

export function primaryChange(finding: Pick<FindingView, "type" | "raw">) {
  if (finding.type === "cost_rise") {
    return { label: "Cost index per click", value: finding.raw.costPerClickChangePct, metric: "cost" };
  }
  return { label: "Conversion-link rate", value: finding.raw.cvrChangePct, metric: "cvr" };
}

export function issueLead(finding: Pick<FindingView, "type" | "campaignName" | "raw" | "interpretation">) {
  const clicks = formatChange(finding.raw.clicksChangePct);
  const cvr = formatChange(finding.raw.cvrChangePct);
  const conversions = finding.raw.conversionDelta == null ? "no comparison" : formatCount(finding.raw.conversionDelta);
  if (finding.type === "cvr_anomaly") return `${finding.campaignName}: clicks changed ${clicks}, conversion-linked clicks changed ${conversions}, and post-click conversion-link rate changed ${cvr}.`;
  if (finding.type === "cost_rise") return `${finding.campaignName}: cost index per click changed ${formatChange(finding.raw.costPerClickChangePct)} and conversion-link rate changed ${cvr}.`;
  if (finding.type === "weak_click_efficiency") return `${finding.campaignName}: post-click conversion-link rate is ${formatRate(finding.raw.cvr)}, ${cvr} versus the comparison window.`;
  if (finding.type === "scale_opportunity") return `${finding.campaignName}: post-click conversion-link rate is ${cvr} versus its comparison window, indicating a positive efficiency signal.`;
  if (finding.type === "data_gap") return `${finding.campaignName} does not have enough click volume or comparison data to support an optimization action.`;
  return finding.interpretation;
}

export function deltaTone(metric: string, value: number | null | undefined): "positive" | "negative" | "neutral" {
  if (value == null || !Number.isFinite(value) || value === 0) return "neutral";
  const up = value > 0;
  if (metric === "cost") return "neutral";
  return up ? "positive" : "negative";
}

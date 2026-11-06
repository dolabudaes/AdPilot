import { cleanWindowLabel } from "./windows";
import type { DecisionView, RecommendationStatus } from "./types";

export type CampaignDecisionSummary = {
  key: "none" | RecommendationStatus | "multiple";
  label: string;
  href: string | null;
};

type DecisionRow = Pick<DecisionView, "id" | "campaignId" | "status"> & Partial<Pick<DecisionView, "windowId" | "windowLabel">>;

export function decisionsForCampaign(
  decisions: DecisionRow[],
  campaignId: string,
  windowId?: string | null
) {
  return decisions.filter((item) => item.campaignId === campaignId && (!windowId || item.windowId === windowId));
}

export function summarizeCampaignDecisions(
  decisions: DecisionRow[],
  campaignId: string,
  options?: { windowId?: string | null; history?: "window" | "all" }
): CampaignDecisionSummary {
  const scope = options?.history || "window";
  const windowId = scope === "window" ? options?.windowId || null : null;
  const items = decisionsForCampaign(decisions, campaignId, windowId);
  if (!items.length) return { key: "none", label: "No decision", href: null };
  const hrefExtra = scope === "all"
    ? `&history=all`
    : items[0].windowId
      ? `&window=${encodeURIComponent(items[0].windowId)}`
      : "";
  const windowSuffix = (windowLabel: string | null | undefined) => {
    if (scope !== "all") return "";
    const text = cleanWindowLabel(windowLabel) || "";
    return text ? ` · ${text}` : "";
  };
  if (items.length > 1) {
    const statuses = ["draft", "confirmed", "dismissed"].filter((status) => items.some((item) => item.status === status));
    const windows = [...new Set(items.map((item) => cleanWindowLabel(item.windowLabel) || item.windowId).filter(Boolean))];
    const windowBit = scope === "all" ? (windows.length === 1 ? ` · ${windows[0]}` : windows.length > 1 ? " · multiple windows" : "") : "";
    return {
      key: "multiple",
      label: `${statuses.map(statusWord).join(" + ")}${windowBit}`,
      href: `/decisions?campaign=${encodeURIComponent(campaignId)}${hrefExtra}`,
    };
  }
  const item = items[0];
  return {
    key: item.status,
    label: `${statusWord(item.status)}${windowSuffix(item.windowLabel || item.windowId)}`,
    href: `/decisions?id=${encodeURIComponent(item.id)}${item.windowId ? `&window=${encodeURIComponent(item.windowId)}` : ""}`,
  };
}

function statusWord(status: string) {
  if (status === "draft") return "Draft";
  if (status === "confirmed") return "Confirmed";
  if (status === "dismissed") return "Dismissed";
  return status;
}

export function campaignMatchesDecisionFilter(
  decisions: DecisionRow[],
  campaignId: string,
  filter: "all" | "none" | RecommendationStatus,
  windowId?: string | null
) {
  if (filter === "all") return true;
  const items = decisionsForCampaign(decisions, campaignId, windowId);
  if (filter === "none") return items.length === 0;
  return items.some((item) => item.status === filter);
}

import type { FindingType } from "./types";
import { STATUS_LABEL } from "./labels";
import type { ConversationRecord } from "./conversations";
import type { FindingView, ProductModel } from "./types";

/** User-facing issue titles (distinct from short finding labels used in queues). */
export const ISSUE_TITLE: Record<FindingType, string> = {
  cvr_anomaly: "Conversion-link rate review",
  weak_click_efficiency: "Click conversion-link review",
  cost_rise: "Rising acquisition costs",
  scale_opportunity: "Conversion-link rate improvement",
  attribution_anomaly: "Attribution pattern review",
  data_gap: "Insufficient sample review",
};

export function issueTitleForFinding(finding: Pick<FindingView, "type">) {
  return ISSUE_TITLE[finding.type];
}

export function investigationConversationTitle(finding: FindingView) {
  return `${finding.campaignName} · ${issueTitleForFinding(finding)}`;
}

/** Short English history title derived from the user's question. */
export function summarizeConversationTitle(question: string, campaignName?: string | null) {
  const q = question.replace(/\s+/g, " ").trim();
  const lower = q.toLowerCase();
  const name = campaignName && campaignName !== "Account" ? campaignName : "";
  if (!q || /^(hi|hello|hey|test)\b[.!?\s]*$/i.test(q)) {
    return "New conversation";
  }
  const topic = (phrase: string) => {
    if (name && lower.includes(name.toLowerCase())) return `${name} ${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`;
    return phrase;
  };
  if (/which campaigns|need attention/.test(lower)) return "Campaigns needing attention";
  if (/scale/.test(lower)) return topic("Scaling opportunity");
  if (/daily trend/.test(lower)) return topic("Daily trend");
  if (/same pattern|compar/.test(lower)) return topic("Pattern comparison");
  if (/creative/.test(lower)) return topic("Creative check");
  if (/evidence/.test(lower)) return topic("Evidence check");
  if (/(investigate|check|verif)\w*\s+next|next\b/.test(lower)) return topic("Next checks");
  if (/conservative/.test(lower)) return topic("Conservative option");
  if (/human review|proposal/.test(lower)) return topic("Review brief");
  if (/cvr|conversion/.test(lower)) return topic("Conversion decline");
  if (/ctr|click efficiency|click-through/.test(lower)) return topic("Click efficiency");
  if (/cost/.test(lower)) return topic("Cost change");
  if (/attribution/.test(lower)) return topic("Attribution review");

  let core = q.replace(/\?+$/, "").replace(/^(why did|why is|why are|why|how did|how is|how|what should|what|where can|where|when|which|can you|could you|could|does|do|is|are|show me|show the|show)\s+/i, "");
  core = core.replace(/^(the|a|an)\s+/i, "");
  core = core.charAt(0).toUpperCase() + core.slice(1);
  if (core.length > 52) core = `${core.slice(0, 49).trimEnd()}…`;
  return topic(core);
}

export function campaignDisplayName(model: ProductModel, campaignId: string | null) {
  if (!campaignId) return "Account";
  return model.campaigns.find((item) => item.id === campaignId)?.name || campaignId;
}

export function investigationStatusLabel(finding: FindingView | null) {
  if (!finding?.recommendation) return "In progress";
  return STATUS_LABEL[finding.recommendation.status] || finding.recommendation.status;
}

export function formatInvestigationUpdated(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function sidebarThreadLabel(conv: ConversationRecord, model: ProductModel, siblingIndex: number, siblingCount: number) {
  const finding = model.findings.find((item) => item.id === conv.findingId);
  if (conv.titleCustom) return conv.title;
  if (finding && siblingCount > 1) {
    return siblingIndex === 0 ? issueTitleForFinding(finding) : `Follow-up · ${formatInvestigationUpdated(conv.updatedAt)}`;
  }
  if (finding) return issueTitleForFinding(finding);
  return conv.title;
}

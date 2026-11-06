import type { ConversationRecord } from "./conversations";
import {
  campaignDisplayName,
  formatInvestigationUpdated,
  sidebarThreadLabel,
} from "./issue-titles";
import type { FindingView, ProductModel } from "./types";

export type WorkspaceView = "discuss" | "review" | "compose";

export function buildWorkspaceUrl(input: {
  accountId: string;
  windowId: string;
  findingId?: string | null;
  campaignId?: string | null;
  conversationId?: string | null;
  view?: WorkspaceView;
}) {
  const view = input.view || "discuss";
  const params = new URLSearchParams({ account: input.accountId, window: input.windowId, view });
  if (view === "compose") {
    if (input.campaignId) params.set("campaign", input.campaignId);
    return `/workspace?${params.toString()}`;
  }
  if (input.findingId) params.set("finding", input.findingId);
  if (input.campaignId) params.set("campaign", input.campaignId);
  if (input.conversationId) params.set("conversation", input.conversationId);
  return `/workspace?${params.toString()}`;
}

export function resolveFinding(model: ProductModel, findingId: string | null, campaignId: string | null): FindingView | null {
  if (findingId) {
    const byId = model.findings.find((item) => item.id === findingId);
    if (byId) return byId;
  }
  if (campaignId) {
    return model.findings.find((item) => item.campaignId === campaignId) || null;
  }
  return null;
}

export type ConversationGroup = {
  campaignId: string;
  campaignName: string;
  items: ConversationRecord[];
};

export type InvestigationSidebarRow = {
  conversation: ConversationRecord;
  campaignId: string;
  campaignName: string;
  issueTitle: string;
  threadLabel: string;
  windowLabel: string;
  updatedLabel: string;
};

export type InvestigationSidebarGroup = {
  campaignId: string;
  campaignName: string;
  rows: InvestigationSidebarRow[];
};

export function listInvestigationSidebar(
  conversations: ConversationRecord[],
  model: ProductModel,
  filter: "all" | "recent"
) {
  let rows = conversations
    .filter((item) => (item.contextType === "investigation" || item.contextType === "account") && item.status === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (filter === "recent") rows = rows.slice(0, 12);

  const byFinding = new Map<string, ConversationRecord[]>();
  for (const item of rows) {
    const key = item.findingId || item.id;
    const bucket = byFinding.get(key) || [];
    bucket.push(item);
    byFinding.set(key, bucket);
  }

  return rows.map((conversation) => {
    const finding = model.findings.find((item) => item.id === conversation.findingId) || null;
    const siblings = byFinding.get(conversation.findingId || conversation.id) || [conversation];
    const siblingIndex = siblings.findIndex((item) => item.id === conversation.id);
    const campaignId = conversation.contextType === "account" ? "account" : conversation.campaignId || "account";
    return {
      conversation,
      campaignId,
      campaignName: campaignDisplayName(model, conversation.campaignId),
      issueTitle: conversation.title,
      threadLabel: sidebarThreadLabel(conversation, model, siblingIndex, siblings.length),
      windowLabel: finding?.windowLabel || (model.window?.id === conversation.windowId ? model.window.label : readableWindowId(conversation.windowId)),
      updatedLabel: formatInvestigationUpdated(conversation.updatedAt),
    };
  });
}

export function groupInvestigationSidebarRows(rows: InvestigationSidebarRow[]): InvestigationSidebarGroup[] {
  const groups = new Map<string, InvestigationSidebarGroup>();
  for (const row of rows) {
    const accountWide = row.conversation.contextType === "account";
    const campaignId = accountWide ? "account" : row.campaignId;
    const campaignName = campaignId === "account" ? "Account-wide" : row.campaignName;
    const existing = groups.get(campaignId);
    if (existing) existing.rows.push(row);
    else groups.set(campaignId, { campaignId, campaignName, rows: [row] });
  }
  return [...groups.values()];
}

export function groupConversations(conversations: ConversationRecord[], model: ProductModel, filter: "all" | "recent") {
  const rows = listInvestigationSidebar(conversations, model, filter);
  const map = new Map<string, ConversationGroup>();
  for (const row of rows) {
    const existing = map.get(row.campaignId);
    if (existing) existing.items.push(row.conversation);
    else map.set(row.campaignId, { campaignId: row.campaignId, campaignName: row.campaignName, items: [row.conversation] });
  }
  return [...map.values()].sort((a, b) => a.campaignName.localeCompare(b.campaignName));
}

function readableWindowId(windowId: string) {
  if (windowId === "recent_7d") return "Recent days";
  if (windowId === "previous_7d") return "Prior days";
  if (windowId === "full_range") return "Full range";
  return windowId.replace(/^d(\d+)-d(\d+)$/, "D$1–D$2");
}

export function reviewCtaLabel(finding: FindingView | null) {
  const status = finding?.recommendation?.status;
  if (!finding?.recommendation) return "Prepare recommendation";
  if (status === "draft") return "Review draft";
  if (status === "confirmed") return finding.recommendation.decisionId ? "View decision" : "Review recommendation";
  if (status === "dismissed") return "View dismissed recommendation";
  return "Review recommendation";
}

export function decisionCtaForConversation(
  messages: Array<{
    id?: string;
    role: "user" | "assistant";
    content: string;
    status: "pending" | "completed" | "failed";
    kind: "chat" | "metrics" | "investigation" | "proposal" | "diff" | "review";
    reviewReady: boolean;
    revision: unknown | null;
    investigation: { presentation?: { actions?: Array<{ id: string }> } } | null;
  }>,
  hasRecommendation: boolean,
  decisionId: string | null | undefined
): "view" | "review" | null {
  if (decisionId) return "view";
  if (!hasRecommendation) return null;
  const assistantIndex = messages.map((message) => message.role === "assistant" && message.status === "completed").lastIndexOf(true);
  if (assistantIndex < 0) return null;
  const assistant = messages[assistantIndex];
  if (!assistant.content.trim()) return null;
  if (assistant.reviewReady || assistant.revision || assistant.kind === "proposal" || assistant.kind === "diff" || assistant.kind === "review") return "review";
  const hasInvestigation = Boolean(assistant.investigation?.presentation) || assistant.kind === "investigation" || assistant.kind === "metrics";
  const hasDecisionBrief = assistant.investigation?.presentation?.actions?.some((action) => action.id === "decision_brief");
  const user = [...messages.slice(0, assistantIndex)].reverse().find((message) => message.role === "user");
  const actionIntent = /recommend(?:ation)?|proposal|decision|what action|which action|what should (?:we|i) do|next action|human review|priority/i.test(user?.content || "");
  if (hasDecisionBrief || actionIntent || hasInvestigation) return "review";
  return null;
}

export function proposalPlacementForConversation(
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    status: "pending" | "completed" | "failed";
    kind: "chat" | "metrics" | "investigation" | "proposal" | "diff" | "review";
    reviewReady: boolean;
    revision: unknown | null;
    investigation: { presentation?: { actions?: Array<{ id: string }> } } | null;
  }>,
  hasRecommendation: boolean,
  decisionId: string | null | undefined,
  preferredMessageId: string | null | undefined
): { messageId: string; label: "Create Review Decision" | "View Recommendation" } | null {
  const cta = decisionCtaForConversation(messages, hasRecommendation, decisionId);
  if (!cta) return null;
  const preferred = preferredMessageId
    ? messages.find((message) => message.id === preferredMessageId && message.role === "assistant" && message.status === "completed")
    : null;
  const source = preferred || [...messages].reverse().find((message) => message.role === "assistant" && message.status === "completed");
  if (!source) return null;
  return {
    messageId: source.id,
    label: decisionId ? "View Recommendation" : "Create Review Decision",
  };
}

import { getDatasetMeta } from "@/lib/analytics";
import { getCurrentActor } from "@/lib/auth";
import {
  getConversationForActor,
  listConversationLinks,
  listConversations,
  listMessages,
  type ConversationRecord,
  type MessageRecord,
} from "@/lib/copilot/conversations";
import { snapshotsMatch } from "@/lib/copilot/pin-window";
import { buildProductModel } from "@/lib/copilot/service";
import { CopilotError } from "@/lib/copilot/store";
import type { ProductModel, Role } from "@/lib/copilot/types";

export type InvestigationView = "discuss" | "evidence" | "decision" | "review" | "compose";
type Search = Record<string, string | string[] | undefined>;

function read(searchParams: Search | undefined, key: string) {
  const value = searchParams?.[key];
  return typeof value === "string" ? value : "";
}

export function loadInvestigation(searchParams?: Search, forcedView?: string): {
  model: ProductModel;
  role: Role;
  findingId: string | null;
  campaignId: string | null;
  view: InvestigationView;
  conversations: ConversationRecord[];
  conversation: ConversationRecord | null;
  messages: MessageRecord[];
  contextError: string | null;
  snapshotMismatch: boolean;
  pinnedWindowId: string | null;
} {
  const actor = getCurrentActor();
  const accountParam = read(searchParams, "account") || null;
  let windowId = read(searchParams, "window") || null;
  const findingIdParam = read(searchParams, "finding") || null;
  const campaignIdParam = read(searchParams, "campaign") || null;
  const requested = read(searchParams, "conversation");
  const viewRaw = forcedView || read(searchParams, "view") || "discuss";
  const view: InvestigationView =
    viewRaw === "compose"
      ? "compose"
      : viewRaw === "review" || viewRaw === "decision"
        ? "review"
        : "discuss";

  let openedEarly: ConversationRecord | null = null;
  let contextError: string | null = null;
  if (requested && view !== "compose") {
    try {
      const opened = getConversationForActor(requested, actor.id);
      if (opened.status !== "active") {
        contextError = "This conversation is archived.";
      } else if (accountParam && opened.accountId !== accountParam) {
        contextError = "This conversation does not match the requested account, window, or finding.";
      } else {
        openedEarly = opened;
        windowId = opened.windowId;
      }
    } catch (error) {
      if (!(error instanceof CopilotError)) throw error;
      contextError = error.message;
    }
  }

  const model = buildProductModel({ accountId: accountParam || openedEarly?.accountId || null, windowId });
  const conversations = model.account.id ? listConversations(actor.id, model.account.id) : [];
  const links = model.account.id ? listConversationLinks(actor.id, model.account.id) : {};
  let conversation: ConversationRecord | null = null;
  let messages: MessageRecord[] = [];
  let findingId = openedEarly?.findingId || findingIdParam;
  if (!findingId && campaignIdParam) {
    findingId = model.findings.find((item) => item.campaignId === campaignIdParam)?.id || null;
  }
  const candidate = view === "compose" ? requested : requested || (findingId ? links[findingId] : "") || "";
  if (openedEarly && openedEarly.accountId === model.account.id && openedEarly.windowId === model.window?.id) {
    conversation = openedEarly;
    messages = listMessages(openedEarly.id, actor.id).messages;
    findingId = model.findings.some((item) => item.id === openedEarly.findingId)
      ? openedEarly.findingId
      : model.findings.find((item) => item.campaignId === openedEarly.campaignId)?.id || null;
  } else if (candidate && !openedEarly) {
    try {
      const opened = getConversationForActor(candidate, actor.id);
      const findingMatches = !findingId || opened.findingId === findingId;
      const windowMatches = opened.windowId === model.window?.id;
      if (opened.accountId === model.account.id && opened.status === "active" && findingMatches && windowMatches) {
        conversation = opened;
        messages = listMessages(opened.id, actor.id).messages;
      } else if (!contextError) {
        contextError = "This conversation does not match the requested account, window, or finding.";
      }
    } catch (error) {
      if (!(error instanceof CopilotError)) throw error;
      contextError = error.message;
    }
  }
  if (view !== "compose" && !conversation && findingId && !model.findings.some((item) => item.id === findingId)) {
    contextError = "This finding is not available in the requested analysis window.";
  }
  const meta = getDatasetMeta();
  const recordedVersion = conversation?.datasetGeneratedAt || null;
  const snapshotMismatch = Boolean(conversation && !snapshotsMatch(recordedVersion, [meta.datasetVersion, meta.generatedAt, model.generatedAt, meta.sourceSha256]));
  return {
    model,
    role: actor.role,
    findingId: view === "compose" ? null : conversation?.findingId && model.findings.some((item) => item.id === conversation.findingId) ? conversation.findingId : findingId,
    campaignId: campaignIdParam || conversation?.campaignId || model.findings.find((item) => item.id === findingId)?.campaignId || null,
    view,
    conversations,
    conversation,
    messages,
    contextError: conversation ? null : contextError,
    snapshotMismatch,
    pinnedWindowId: conversation?.windowId || null,
  };
}

import { redirect } from "next/navigation";
import { getDatasetMeta } from "@/lib/analytics";
import { getCurrentActor } from "@/lib/auth";
import { getConversationForAccount, listMessages } from "@/lib/copilot/conversations";
import { debugDecision } from "@/lib/copilot/debug";
import { listReportsForConversation } from "@/lib/copilot/investigate/report";
import { decisionsHref, resolveDecisionSelection } from "@/lib/copilot/decision-selection";
import { pinnedSearch } from "@/lib/copilot/pin-window";
import { listStrategyVersionsForRecommendation } from "@/lib/copilot/strategy-versions";
import { listDecisions } from "@/lib/copilot/service";
import { DecisionScreen } from "./screen";

export const dynamic = "force-dynamic";

export default function DecisionsPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const status = typeof searchParams?.status === "string" ? searchParams.status : "all";
  const selected = typeof searchParams?.id === "string" ? searchParams.id : null;
  const campaign = typeof searchParams?.campaign === "string" ? searchParams.campaign : null;
  const historyAll = searchParams?.history === "all";
  const selectedIdParam = selected;
  const filterWindow = null;
  const campaignScope = selectedIdParam ? null : campaign;
  const actor = getCurrentActor();
  const decisions = listDecisions("all");
  const resolved = resolveDecisionSelection({
    decisions,
    status,
    selectedId: selected,
    campaignId: campaignScope,
    filterWindow,
  });
  if (resolved.needsRedirect) {
    redirect(decisionsHref({
      status,
      id: resolved.selectedId,
      campaignId: campaignScope,
      window: filterWindow || resolved.selected?.windowId || null,
      history: historyAll ? "all" : null,
    }));
  }
  const selectedDecision = resolved.selected ? decisions.find((item) => item.id === resolved.selectedId) || null : null;
  const requestedWindow = typeof searchParams?.window === "string" ? searchParams.window : "";
  if (selectedDecision?.windowId && requestedWindow !== selectedDecision.windowId) {
    redirect(`/decisions?${pinnedSearch(searchParams, { window: selectedDecision.windowId })}`);
  }
  const investigationContexts = Object.fromEntries(decisions.map((decision) => {
    const versions = listStrategyVersionsForRecommendation(decision.recommendationId);
    const conversationId = decision.conversationId;
    if (!conversationId) {
      debugDecision("missing-conversation", {
        decisionId: decision.id,
        campaignId: decision.campaignId,
        findingId: decision.findingId,
        windowId: decision.windowId,
        snapshotId: decision.datasetVersion,
      });
      return [decision.id, { conversation: null, reports: [], versions, messages: [] }] as const;
    }
    try {
      const item = getConversationForAccount(conversationId, "criteo-demo");
      const messages = listMessages(item.id, item.ownerId, null, 40).messages;
      debugDecision("bind-conversation", {
        decisionId: decision.id,
        conversationId,
        campaignId: decision.campaignId,
        windowId: decision.windowId,
        snapshotId: decision.datasetVersion,
      });
      return [decision.id, { conversation: item, reports: listReportsForConversation(item.id), versions, messages }] as const;
    } catch {
      debugDecision("invalid-conversation", {
        decisionId: decision.id,
        conversationId,
        campaignId: decision.campaignId,
      });
      return [decision.id, { conversation: null, reports: [], versions, messages: [] }] as const;
    }
  }));
  return (
    <DecisionScreen
      decisions={decisions}
      role={actor.role}
      status={status}
      selectedId={resolved.selectedId}
      campaignId={campaignScope}
      filterWindow={filterWindow}
      investigationContexts={investigationContexts}
      currentDatasetVersion={getDatasetMeta().datasetVersion}
      currentGeneratedAt={getDatasetMeta().generatedAt}
    />
  );
}

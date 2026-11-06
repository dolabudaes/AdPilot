"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionType } from "@/lib/analytics/types";
import { ConfirmDialog } from "@/components/copilot/confirm-dialog";
import { ConversationThread } from "@/components/copilot/conversation-thread";
import { EvidenceInspector } from "@/components/copilot/evidence-inspector";
import { InvestigationSidebar } from "@/components/copilot/investigation-sidebar";
import { NewInvestigationCompose } from "@/components/copilot/new-investigation-compose";
import { investigationStartersFor } from "@/lib/copilot/investigation-starters";
import { fetchJson } from "@/lib/clientApi";
import { ACTION_LABEL, STATUS_LABEL } from "@/lib/copilot/labels";
import { can, type Role } from "@/lib/copilot/permissions";
import { proposalConsistencyIssue } from "@/lib/copilot/proposal-consistency";
import type { ConversationRecord, MessageRecord } from "@/lib/copilot/conversations";
import {
  buildWorkspaceUrl,
  groupInvestigationSidebarRows,
  listInvestigationSidebar,
  proposalPlacementForConversation,
  resolveFinding,
  type WorkspaceView,
} from "@/lib/copilot/workspace-nav";
import type { FindingView, ProductModel, StrategyVersion } from "@/lib/copilot/types";
import { cleanWindowLabel, formatWindowRange } from "@/lib/copilot/windows";

const ACTIONS: ActionType[] = ["review", "hold", "decrease_priority", "increase_priority", "pause_candidate"];

export function WorkspaceScreen({
  model,
  role,
  initialFindingId,
  initialCampaignId,
  initialView,
  conversations,
  conversation,
  messages,
  versions,
  contextError,
  windowOptions,
  snapshotMismatch,
}: {
  model: ProductModel;
  role: Role;
  initialFindingId?: string | null;
  initialCampaignId?: string | null;
  initialView: "discuss" | "evidence" | "decision" | "review" | "compose";
  conversations: ConversationRecord[];
  conversation: ConversationRecord | null;
  messages: MessageRecord[];
  versions: StrategyVersion[];
  contextError: string | null;
  windowOptions: Array<{ id: string; label: string }>;
  snapshotMismatch?: boolean;
  pinnedWindowId?: string | null;
}) {
  const router = useRouter();
  const composeMode = initialView === "compose";
  const finding = composeMode ? null : resolveFinding(model, initialFindingId || null, initialCampaignId || null);
  const [sidebarFilter, setSidebarFilter] = useState<"recent" | "all">("recent");
  const [campaignQuery, setCampaignQuery] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceFocus, setEvidenceFocus] = useState<string | null>(null);
  const [invSidebarCollapsed, setInvSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{ conversation: ConversationRecord; issueTitle: string } | null>(null);
  const reviewMode = !composeMode && initialView === "review" && Boolean(finding);
  const proposalSourceMessageId = versions.find((version) => version.messageId)?.messageId || null;
  const proposalPlacement = finding
    ? proposalPlacementForConversation(messages, Boolean(finding.recommendation), finding.recommendation?.decisionId, proposalSourceMessageId)
    : null;
  const visibleProposalPlacement = proposalPlacement && (proposalPlacement.label === "View Recommendation" || can(role, "edit_recommendation"))
    ? proposalPlacement
    : null;

  const sidebarRows = useMemo(() => listInvestigationSidebar(conversations, model, sidebarFilter), [conversations, model, sidebarFilter]);
  const filteredSidebarRows = useMemo(() => {
    if (!campaignQuery.trim()) return sidebarRows;
    const q = campaignQuery.toLowerCase();
    return sidebarRows.filter(
      (row) =>
        row.campaignName.toLowerCase().includes(q) ||
        row.issueTitle.toLowerCase().includes(q) ||
        (row.conversation.prompt || "").toLowerCase().includes(q) ||
        row.threadLabel.toLowerCase().includes(q)
    );
  }, [sidebarRows, campaignQuery]);
  const sidebarGroups = useMemo(() => groupInvestigationSidebarRows(filteredSidebarRows), [filteredSidebarRows]);
  const investigationStarters = useMemo(
    () => investigationStartersFor(model, finding?.campaignId || initialCampaignId || conversation?.campaignId),
    [model, finding?.campaignId, initialCampaignId, conversation?.campaignId]
  );

  function navigate(patch: {
    finding?: FindingView | null;
    conversation?: ConversationRecord | null;
    view?: WorkspaceView;
    windowId?: string;
  }) {
    const fromHistory = Object.prototype.hasOwnProperty.call(patch, "finding") && !patch.finding && patch.conversation;
    const f = fromHistory ? null : patch.finding === undefined ? finding : patch.finding;
    const conv = patch.conversation === undefined ? conversation : patch.conversation;
    const windowId = patch.windowId || conv?.windowId || model.window?.id || "recent_7d";
    router.push(
      buildWorkspaceUrl({
        accountId: model.account.id,
        windowId,
        findingId: fromHistory ? conv?.findingId || null : f?.id || conv?.findingId || null,
        campaignId: fromHistory ? conv?.campaignId || null : f?.campaignId || conv?.campaignId || null,
        conversationId: conv?.id || null,
        view: patch.view || (reviewMode ? "review" : composeMode ? "compose" : "discuss"),
      })
    );
    router.refresh();
  }

  function openCompose() {
    setMobileSidebarOpen(false);
    router.push(
      buildWorkspaceUrl({
        accountId: model.account.id,
        windowId: model.window?.id || "recent_7d",
        view: "compose",
      })
    );
    router.refresh();
  }

  function requestDelete(row: { conversation: ConversationRecord; issueTitle: string }) {
    if (busy) return;
    setPendingDelete(row);
  }

  async function confirmDelete() {
    if (!pendingDelete || busy) return;
    const row = pendingDelete;
    setBusy(true);
    setNotice("");
    try {
      await fetchJson(`/api/conversations/${row.conversation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      });
      setPendingDelete(null);
      if (conversation?.id === row.conversation.id) {
        openCompose();
      } else {
        router.refresh();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete this investigation.");
    } finally {
      setBusy(false);
    }
  }

  async function openDecisionDraft() {
    if (!finding?.recommendation || busy) return;
    if (finding.recommendation.decisionId) {
      router.push(`/decisions?id=${encodeURIComponent(finding.recommendation.decisionId)}`);
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const result = await fetchJson<{ decision: { id: string } }>("/api/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ findingId: finding.id, conversationId: conversation?.id || null }),
      }, "The review decision could not be opened.");
      router.push(`/decisions?id=${encodeURIComponent(result.decision.id)}`);
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The review decision could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  async function startFromCompose(input: { question: string; campaignScope: string; windowId: string }) {
    setBusy(true);
    setNotice("");
    try {
      let campaignId = input.campaignScope !== "all" ? input.campaignScope : null;
      if (!campaignId) {
        const mention = model.campaigns.find((c) => input.question.toLowerCase().includes(c.name.toLowerCase()));
        campaignId = mention?.id || null;
      }
      const opened = await fetchJson<{ conversation: ConversationRecord }>("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: model.account.id,
          windowId: input.windowId,
          campaignId,
          contextType: campaignId ? "investigation" : "account",
          resume: false,
          forceNew: true,
        }),
      });
      await fetchJson(`/api/conversations/${opened.conversation.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: input.question, clientKey: crypto.randomUUID() }),
      });
      router.push(
        buildWorkspaceUrl({
          accountId: model.account.id,
          windowId: input.windowId,
          findingId: opened.conversation.findingId,
          campaignId: opened.conversation.campaignId,
          conversationId: opened.conversation.id,
          view: "discuss",
        })
      );
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not start investigation.");
    } finally {
      setBusy(false);
    }
  }

  if (contextError && !composeMode) {
    return (
      <div className="ap-context-error">
        <h1>Investigation unavailable</h1>
        <p>{contextError}</p>
        <button type="button" className="ap-btn primary" onClick={openCompose}>New investigation</button>
      </div>
    );
  }

  const shellClass = `ap-workspace-v2 ap-workspace-v4${invSidebarCollapsed ? " inv-sidebar-collapsed" : ""}`;

  return (
    <main className={shellClass}>
      <InvestigationSidebar
        groups={sidebarGroups}
        resultCount={filteredSidebarRows.length}
        campaignQuery={campaignQuery}
        onCampaignQuery={setCampaignQuery}
        sidebarFilter={sidebarFilter}
        onSidebarFilter={setSidebarFilter}
        collapsed={invSidebarCollapsed}
        onToggleCollapsed={() => setInvSidebarCollapsed((v) => !v)}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
        activeConversationId={composeMode ? null : conversation?.id}
        busy={busy}
        role={role}
        onNewInvestigation={openCompose}
        onSelect={(row) => {
          setMobileSidebarOpen(false);
          navigate({
            conversation: row.conversation,
            finding: null,
            view: "discuss",
            windowId: row.conversation.windowId,
          });
        }}
        onDelete={(row) => requestDelete(row)}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete this investigation?"
        description="It will be removed from your investigations list. You can keep working on other chats right away."
        detail={pendingDelete?.issueTitle}
        confirmLabel="Delete investigation"
        busy={busy && Boolean(pendingDelete)}
        onCancel={() => {
          if (!busy) setPendingDelete(null);
        }}
        onConfirm={() => void confirmDelete()}
      />

      {mobileSidebarOpen ? <button type="button" className="ap-ws-mobile-scrim" aria-label="Close investigations" onClick={() => setMobileSidebarOpen(false)} /> : null}

      <section className="ap-ws-main ap-ws-main-centered">
        <button
          type="button"
          className="ap-mobile-investigations-toggle"
          aria-expanded={mobileSidebarOpen}
          onClick={() => setMobileSidebarOpen(true)}
        >
          Open investigations <span>{filteredSidebarRows.length}</span>
        </button>
        {composeMode || !conversation ? (
          <NewInvestigationCompose
            key={`${finding?.campaignId || initialCampaignId || "all"}-${model.window?.id || "recent_7d"}`}
            role={role}
            campaigns={model.campaigns}
            windows={windowOptions.length ? windowOptions : [{ id: model.window?.id || "recent_7d", label: model.window?.label || "Window" }]}
            defaultCampaignId={finding?.campaignId || conversation?.campaignId || initialCampaignId}
            defaultWindowId={model.window?.id || "recent_7d"}
            busy={busy}
            notice={notice}
            snapshotLabel={formatWindowRange(model.window) || model.window?.label || "Window"}
            starters={investigationStarters}
            onSubmit={(input) => void startFromCompose(input)}
          />
        ) : reviewMode && finding ? (
          <RecommendationReview
            finding={finding}
            conversation={conversation}
            messages={messages}
            versions={versions}
            role={role}
            onBack={() => navigate({ finding, conversation, view: "discuss" })}
          />
        ) : (
          <div className="ap-ws-active">
            <header className="ap-ws-header ap-ws-header-v4">
              <div>
                <h1>{conversation.title}</h1>
                <p className="ap-ws-issue-line">
                  {[
                    finding?.campaignName || model.campaigns.find((item) => item.id === conversation.campaignId)?.name || "Account-wide",
                    finding
                      ? formatWindowRange({ label: finding.windowLabel, compareLabel: finding.compareLabel || conversation.compareLabel })
                      : formatWindowRange({ label: model.window?.label || conversation.snapshotLabel, compareLabel: conversation.compareLabel || model.window?.compareLabel }) || cleanWindowLabel(conversation.windowId),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {snapshotMismatch ? (
                  <p className="ap-snapshot-banner" role="status">
                    This investigation uses a different snapshot. Follow-ups are blocked.
                  </p>
                ) : null}
              </div>
              {can(role, "converse") ? (
                <button
                  type="button"
                  className="ap-btn ap-ws-delete-chat"
                  disabled={busy}
                  onClick={() =>
                    requestDelete({
                      conversation,
                      issueTitle: conversation.title || "This investigation",
                    })
                  }
                >
                  Delete
                </button>
              ) : null}
            </header>

            <div className="ap-ws-thread-column">
              <ConversationThread
                key={conversation.id}
                conversation={conversation}
                initialMessages={messages}
                role={role}
                layout="studio"
                proposal={
                  finding?.recommendation
                    ? { actionType: finding.recommendation.proposal.actionType, status: finding.recommendation.status, decisionId: finding.recommendation.decisionId }
                    : null
                }
                proposalAction={visibleProposalPlacement && finding?.recommendation ? {
                  messageId: visibleProposalPlacement.messageId,
                  title: ["increase_priority", "decrease_priority", "pause_candidate"].includes(finding.recommendation.proposal.actionType)
                    ? finding.recommendation.proposal.title
                    : finding.recommendation.proposal.title,
                  summary: finding.recommendation.proposal.reason,
                  label: visibleProposalPlacement.label,
                } : null}
                onOpenProposal={() => void openDecisionDraft()}
                readOnlySnapshot={snapshotMismatch}
                onCite={(label) => { setEvidenceFocus(label); setEvidenceOpen(true); }}
              />
            </div>
            {notice ? <p className="ap-error-text ap-ws-notice">{notice}</p> : null}
          </div>
        )}
      </section>

      {evidenceOpen && finding ? (
        <>
          <button type="button" className="ap-mobile-scrim" aria-label="Close evidence" onClick={() => setEvidenceOpen(false)} />
          <EvidenceInspector finding={finding} model={model} focusLabel={evidenceFocus} onClose={() => { setEvidenceOpen(false); setEvidenceFocus(null); }} />
        </>
      ) : null}
    </main>
  );
}

function RecommendationReview({
  finding,
  conversation,
  messages,
  versions,
  role,
  onBack,
}: {
  finding: FindingView;
  conversation: ConversationRecord | null;
  messages: MessageRecord[];
  versions: StrategyVersion[];
  role: Role;
  onBack: () => void;
}) {
  const router = useRouter();
  const rec = finding.recommendation;
  const latestRevision = [...messages].reverse().find((m) => m.revision)?.revision;
  const [actionType, setActionType] = useState<ActionType>(latestRevision?.actionType || rec?.proposal.actionType || "review");
  const [reason, setReason] = useState(latestRevision?.reason || proposalReason(finding, rec?.proposal.reason));
  const [reasonEdited, setReasonEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const canEdit = can(role, "edit_recommendation") && (!rec || rec.status === "draft" || rec.status === "dismissed");
  const consistencyIssue = proposalConsistencyIssue(actionType, reason);

  function changeAction(nextAction: ActionType) {
    setActionType(nextAction);
    setFeedback("");
    if (!reasonEdited) setReason(proposalReasonForAction(finding, nextAction));
  }

  async function save() {
    setBusy(true);
    try {
      await persistVersion();
      setFeedback("Draft saved.");
      router.refresh();
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function persistVersion() {
    const messageId = [...messages].reverse().find((message) => message.role === "assistant" && message.status === "completed")?.id || null;
    await fetchJson("/api/strategy-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ findingId: finding.id, actionType, reason, source: "human", conversationId: conversation?.id || null, messageId }),
      });
  }

  async function confirmDecision() {
    const issue = proposalConsistencyIssue(actionType, reason);
    if (issue) {
      setFeedback(issue);
      return;
    }
    setBusy(true);
    setFeedback("");
    try {
      await persistVersion();
      const draft = await fetchJson<{ decision: { id: string } }>("/api/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ findingId: finding.id, conversationId: conversation?.id || null }),
      }, "The review decision could not be opened.");
      const result = await fetchJson<{ decision: { id: string } }>(`/api/decisions/${encodeURIComponent(draft.decision.id)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }, "The recommendation could not be confirmed.");
      setFeedback("Decision confirmed.");
      router.push(`/decisions?id=${encodeURIComponent(result.decision.id)}`);
      router.refresh();
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "The recommendation could not be confirmed.");
    } finally {
      setBusy(false);
    }
  }

  async function dismissDecision() {
    setBusy(true);
    setFeedback("");
    try {
      await persistVersion();
      const result = await fetchJson<{ decision: { id: string } }>("/api/decisions/dismiss-finding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ findingId: finding.id }),
      }, "The recommendation could not be dismissed.");
      setFeedback("Recommendation dismissed.");
      router.push(`/decisions?id=${encodeURIComponent(result.decision.id)}`);
      router.refresh();
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "The recommendation could not be dismissed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ap-ws-review-page">
      <div className="ap-ws-review-scroll">
        <div className="ap-ws-review-shell">
          <header className="ap-ws-review-header">
            <button type="button" className="ap-review-back" onClick={onBack}>← Back to investigation</button>
            <div className="ap-review-title-row">
              <h1>{rec?.updatedAt || versions.length ? "Edit proposal" : "Create proposal"}</h1>
              <span className="ap-review-status">{rec ? STATUS_LABEL[rec.status] : "Draft"}</span>
            </div>
            <p>{[finding.campaignName, formatWindowRange(finding)].filter(Boolean).join(" · ")}</p>
          </header>
          <div className="ap-ws-review-body">
            <div className="ap-review-field">
              <label htmlFor="proposal-action">Recommended action</label>
              <div className="ap-review-select-wrap">
                <select id="proposal-action" value={actionType} onChange={(e) => changeAction(e.target.value as ActionType)} disabled={!canEdit}>
                  {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
                </select>
              </div>
              {rec && actionType !== rec.original.actionType ? <p className="ap-review-field-note">AI recommendation: {ACTION_LABEL[rec.original.actionType]}</p> : null}
            </div>
            <div className="ap-review-field">
              <label htmlFor="proposal-reason">Why this action?</label>
              <textarea
                id="proposal-reason"
                value={reason}
                onChange={(e) => { setReason(e.target.value); setReasonEdited(true); setFeedback(""); }}
                disabled={!canEdit}
              />
              {consistencyIssue ? <p className="ap-review-validation" role="alert">{consistencyIssue}</p> : null}
            </div>
            <section className="ap-review-evidence" aria-labelledby="supporting-evidence-title">
              <h2 id="supporting-evidence-title">Supporting evidence</h2>
              <div>
                {finding.evidence.slice(0, 4).map((e) => (
                  <article key={`${e.label}-${e.value}`}>
                    <span>{proposalEvidenceLabel(e.label)}</span>
                    <strong>{e.value}</strong>
                    {e.delta || e.baseline ? <small>{[e.delta, e.baseline ? `Prior ${e.baseline}` : null].filter(Boolean).join(" · ")}</small> : null}
                  </article>
                ))}
              </div>
            </section>
            {versions.length ? <p className="ap-review-version-count">{versions.length} saved version{versions.length === 1 ? "" : "s"}</p> : null}
          </div>
        </div>
      </div>
      <footer className="ap-ws-review-footer">
        <div className="ap-ws-review-footer-inner">
          {feedback ? <p role="status">{feedback}</p> : <span />}
          <div>
            {canEdit ? <button type="button" className="ap-btn" disabled={busy || reason.trim().length < 8} onClick={() => void save()}>Save draft</button> : null}
            {(!rec || rec.status === "draft" || rec.status === "dismissed") ? <button type="button" className="ap-btn primary" disabled={busy || reason.trim().length < 8 || Boolean(consistencyIssue)} onClick={() => void confirmDecision()}>Confirm Decision</button> : null}
            {(!rec || rec.status === "draft") ? <button type="button" className="ap-btn danger" disabled={busy} onClick={() => void dismissDecision()}>Dismiss</button> : null}
            {rec?.decisionId ? <a className="ap-btn" href={`/decisions?id=${encodeURIComponent(rec.decisionId)}`}>View decision</a> : null}
          </div>
        </div>
      </footer>
    </div>
  );
}

function proposalReason(finding: FindingView, existing?: string) {
  if (existing?.trim() && !hasChinese(existing)) return existing;
  const current = finding.raw.cvr == null ? "unavailable" : `${(finding.raw.cvr * 100).toFixed(2)}%`;
  const prior = finding.raw.previousCvr == null ? null : `${(finding.raw.previousCvr * 100).toFixed(2)}%`;
  const movement = prior ? `from ${prior} to ${current}` : `at ${current} without a prior-window baseline`;
  return `Verify ${finding.campaignName}'s ${finding.type === "cost_rise" ? "cost-index signal" : "conversion-link rate"} ${movement} in the advertising platform before any delivery change.`;
}

function proposalReasonForAction(finding: FindingView, actionType: ActionType) {
  if (actionType === "review") return proposalReason(finding);
  if (actionType === "hold") return `Continue monitoring ${finding.campaignName}'s verified daily pattern while the cause remains unverified.`;
  return `${ACTION_LABEL[actionType]} only after a human verifies the observed signal and the missing delivery context outside this dataset.`;
}

function hasChinese(value: string) { return /[\u3400-\u9fff]/.test(value); }

function proposalEvidenceLabel(value: string) {
  const labels: Record<string, string> = { "点击": "Clicks", "转化": "Conversion-linked clicks", "转化关联点击": "Conversion-linked clicks", "点击后转化率": "Post-click conversion-link rate", "点击后转化关联率": "Post-click conversion-link rate", "点击率": "CTR", "成本指数": "Cost index", "成本指数总值": "Cost index total", "单次点击成本指数": "Average cost index per click", "曝光": "Impressions", "归因转化": "Attributed conversion links" };
  return labels[value] || value;
}

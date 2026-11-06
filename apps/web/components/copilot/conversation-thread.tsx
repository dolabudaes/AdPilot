"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/clientApi";
import { ACTION_LABEL } from "@/lib/copilot/labels";
import { can, type Role } from "@/lib/copilot/permissions";
import { conversationWindow } from "@/lib/copilot/conversation-window";
import { buildFollowUpSuggestions } from "@/lib/copilot/follow-up-suggestions";
import type { ConversationRecord, MessageRecord } from "@/lib/copilot/conversations";
import type { ActionType } from "@/lib/analytics/types";
import { TrendChart } from "./chart";
import { InvestigationFinding } from "./investigation-finding";

export function ConversationThread({
  conversation,
  initialMessages,
  role,
  proposal,
  proposalAction,
  onOpenProposal,
  onCite,
  layout,
  readOnlySnapshot,
}: {
  conversation: ConversationRecord;
  initialMessages: MessageRecord[];
  role: Role;
  proposal?: { actionType: ActionType; status: string; decisionId?: string | null } | null;
  proposalAction?: { messageId: string; title: string; summary: string; label: "Create Review Decision" | "View Recommendation" } | null;
  onOpenProposal?: () => void;
  onCite?: (label: string) => void;
  layout?: "studio";
  readOnlySnapshot?: boolean;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const canSend = can(role, "converse") && !readOnlySnapshot;
  const compactHistory = conversationWindow(messages);
  const visibleMessages = historyExpanded ? messages : compactHistory.visible;
  const followUpSuggestions = buildFollowUpSuggestions(messages.map((message) => ({
    role: message.role,
    content: message.content,
    tools: message.tools,
    reviewReady: message.reviewReady,
    actions: message.investigation?.presentation?.actions || [],
  })), {
    campaignName: conversation.campaignId,
    tools: messages.flatMap((message) => message.tools || []),
    reviewReady: messages.some((message) => message.reviewReady),
    hasCreateCta: proposalAction?.label === "Create Review Decision",
  });

  useEffect(() => {
    setMessages(initialMessages);
    setError("");
    setHistoryExpanded(false);
  }, [conversation.id, initialMessages]);

  useEffect(() => {
    if (historyExpanded || !threadRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const thread = threadRef.current;
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversation.id, historyExpanded, messages.length]);

  async function send(content: string, clientKey = crypto.randomUUID(), retry = false) {
    const value = content.trim();
    if ((!value && !retry) || busy) return;
    setBusy(true);
    setError("");
    if (!retry) {
      setMessages((current) => [
        ...current.filter((item) => item.clientKey !== clientKey && item.clientKey !== `${clientKey}:assistant`),
        localMessage(conversation.id, "user", value, clientKey, "completed"),
        localMessage(conversation.id, "assistant", "", `${clientKey}:assistant`, "pending"),
      ]);
      setText("");
    } else {
      setMessages((current) => current.map((item) => item.clientKey === `${clientKey}:assistant` ? { ...item, status: "pending", error: null } : item));
    }
    try {
      const data = await fetchJson<{ user: MessageRecord; assistant: MessageRecord & { note?: string | null } }>(
        `/api/conversations/${conversation.id}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(retry ? { clientKey, retry: true } : { content: value, clientKey }),
        },
        "The investigation did not return a response."
      );
      setMessages((current) => mergePair(current, data.user, data.assistant));
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "The investigation did not return a response.";
      setError(message);
      setMessages((current) => current.map((item) => item.clientKey === `${clientKey}:assistant` ? { ...item, status: "failed", error: message } : item));
    } finally {
      setBusy(false);
    }
  }

  async function apply(revision: NonNullable<MessageRecord["revision"]>) {
    if (!conversation.findingId) return;
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/strategy-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ findingId: conversation.findingId, actionType: revision.actionType, reason: revision.reason, source: "ai", conversationId: conversation.id }),
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The candidate version was not saved.");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(text);
  }

  return (
    <div className={`ap-thread-wrap${layout === "studio" ? " ap-thread-wrap--studio" : ""}`}>
      <div className="ap-thread ap-thread-main" ref={threadRef}>
        {compactHistory.hiddenCount ? (
          <button className="ap-history-reveal" type="button" onClick={() => setHistoryExpanded((current) => !current)}>
            {historyExpanded ? "Show recent messages" : `Show ${compactHistory.hiddenCount} earlier messages`}
          </button>
        ) : null}
        {visibleMessages.length ? visibleMessages.map((message, messageIndex) => (
          <article className={`ap-turn ${message.role}${message.status === "pending" ? " is-pending" : ""}${layout === "studio" ? ` ap-turn--bubble${message.role === "user" ? " ap-turn--user-right" : " ap-turn--assistant-flow"}` : ""}`} key={message.id}>
            {layout === "studio" ? (
              <header className="ap-turn-head">
                {message.role === "assistant" ? <span className="ap-turn-avatar" aria-hidden="true">A</span> : null}
                <span>{message.role === "user" ? "You" : "AdPilot"}</span>
              </header>
            ) : null}
            <div className="ap-turn-body">
            {message.role === "assistant" && message.status === "pending" ? (
              <p>Analyzing this question against the campaign data…</p>
            ) : message.role === "assistant" && message.status === "failed" ? (
              <div className="ap-message-recovery"><strong>{message.recoveryState === "unrecoverable" ? "Historical answer unavailable" : "Answer failed"}</strong><p>{message.error || "This answer could not be completed."}</p></div>
            ) : message.role === "assistant" && layout === "studio" && message.investigation?.presentation ? (
              <InvestigationFinding
                message={message}
                question={[...visibleMessages.slice(0, messageIndex)].reverse().find((item) => item.role === "user")?.content || ""}
              />
            ) : (
              <p>{displayMessage(message)}</p>
            )}
            {message.role === "assistant" && message.investigation && layout !== "studio" ? <DiagnosisBlocks investigation={message.investigation} /> : null}
            {message.evidence.length ? (
              <details className="ap-cites-collapse" open={layout !== "studio"}>
                <summary>Evidence ({message.evidence.length})</summary>
                <div className="ap-cites">
                  {message.evidence.map((item) => (
                    <button className="ap-cite" key={item.id || item.label} type="button" onClick={() => onCite?.(item.label)}>
                      <span>{englishEvidenceLabel(item.label)}</span>
                      <strong>{displayEvidenceValue(item)}</strong>
                      {item.relative || item.baseline ? <small>{[item.relative, item.baseline ? `Prior ${item.baseline}` : null].filter(Boolean).join(" · ")}</small> : null}
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
            {message.series?.length && layout !== "studio" ? <TrendChart points={message.series} anomalies={[]} metric="cvr" /> : null}
            {message.role === "assistant" && message.steps.length && layout !== "studio" ? (
              <details className="ap-tool-trace-collapse">
                <summary>View analysis details</summary>
                <ToolTrace steps={message.steps} runtime={message.runtime} />
              </details>
            ) : null}
            {message.revision && proposal && (message.kind === "proposal" || message.kind === "diff") ? (
              <div className="ap-diff">
                <div><span>Current formal proposal</span><strong>{ACTION_LABEL[proposal.actionType]}</strong></div>
                <div><span>Candidate revision</span><strong>{ACTION_LABEL[message.revision.actionType]}</strong></div>
                <div><span>Reason</span><span>{displayReason(message.revision.reason)}</span></div>
              </div>
            ) : null}
            {message.revision && can(role, "edit_recommendation") && message.kind !== "review" ? (
              <button className="ap-btn" type="button" disabled={busy} onClick={() => void apply(message.revision!)}>Save as strategy version</button>
            ) : null}
            {message.role === "assistant" && message.status === "completed" && proposalAction?.messageId === message.id ? (
              <section className="ap-message-recommendation">
                <div>
                  <strong>{proposalAction.title}</strong>
                  <p>{proposalAction.summary}</p>
                </div>
                <button className="ap-btn primary" type="button" disabled={busy} onClick={onOpenProposal}>{proposalAction.label}</button>
              </section>
            ) : null}
            {message.kind === "review" && proposal?.decisionId ? <a href={`/decisions?id=${encodeURIComponent(proposal.decisionId)}`}>View decision</a> : null}
            {message.status === "failed" && message.role === "assistant" ? (
              <button className="ap-btn" type="button" disabled={busy} onClick={() => void send(pairedUser(messages, message), userKey(message.clientKey), true)}>{message.recoveryState === "unrecoverable" ? "Re-analyze this question" : "Retry"}</button>
            ) : null}
            </div>
          </article>
        )) : null}
        {error ? <p>{error}</p> : null}
      </div>
      {followUpSuggestions.length ? (
        <div className="ap-filters ap-filters--compact">
          {followUpSuggestions.map((item) => (
            <button key={item} className="ap-chip" type="button" disabled={!canSend || busy} onClick={() => void send(item)}>{item}</button>
          ))}
        </div>
      ) : null}
      <form className="ap-composer" onSubmit={onSubmit}>
        <textarea
          value={text}
          rows={1}
          aria-label="Message AdPilot"
          placeholder={readOnlySnapshot ? "Follow-ups are blocked because this investigation used a different snapshot" : canSend ? "Ask a follow-up about this investigation" : "Your current role cannot send messages"}
          disabled={!canSend || busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(text);
            }
          }}
        />
        <button className="ap-btn primary" type="submit" disabled={!canSend || busy || !text.trim()}>{busy ? "Sending…" : "Send"}</button>
      </form>
    </div>
  );
}

function DiagnosisBlocks({ investigation }: { investigation: NonNullable<MessageRecord["investigation"]> }) {
  const blocks = [
    { title: "What happened", items: investigation.found.slice(0, 3) },
    { title: "What we can verify", items: investigation.found.slice(3, 6) },
    { title: "Recommended next steps", items: investigation.nextSteps.slice(0, 3) },
  ];
  return (
    <div className="ap-diagnosis-blocks">
      {blocks.map((block) => (
        <section key={block.title}>
          <h4>{block.title}</h4>
          {block.items.length ? <ul>{block.items.map((item) => <li key={item}>{englishDiagnosisLine(item)}</li>)}</ul> : <p className="ap-muted">Insufficient evidence to determine the root cause.</p>}
        </section>
      ))}
      {investigation.cannotDetermine.length ? (
        <details className="ap-limits-collapse">
          <summary>Data limits ({investigation.cannotDetermine.length})</summary>
          <ul>{investigation.cannotDetermine.map((item) => <li key={item}>{englishDiagnosisLine(item)}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

function englishDiagnosisLine(value: string) {
  if (!hasChinese(value)) return value;
  const map: Array<[RegExp, string]> = [
    [/没有素材|Creative或受众/, "Creative and audience dimensions are not in this dataset."],
    [/cost 是日志成本指数/, "Cost index is not currency spend, CPA, or ROAS."],
    [/对照 无/, "No comparison baseline in this window."],
    [/规则标记为/, "Rule signal:"],
    [/点击后转化率/, "Reported Click CVR"],
  ];
  for (const [pattern, text] of map) if (pattern.test(value)) return text;
  return "See evidence inspector for supporting metrics.";
}

function ToolTrace({ steps, runtime }: { steps: MessageRecord["steps"]; runtime: MessageRecord["runtime"] }) {
  return (
    <div className="ap-tool-trace">
      <div className="ap-tool-trace-head">
        <span>Tool trace</span>
        {runtime ? <em>{modeLabel(runtime)}</em> : null}
      </div>
      <ol>
        {steps.map((step, index) => (
          <li key={`${step.tool}-${index}`} className={step.ok ? "ok" : "fail"}>
            <strong>{step.tool}</strong>
            <span>{step.picker === "llm" ? "LLM pick" : step.picker === "rule" ? "Rule pick" : "—"}</span>
            <em>{step.ok ? step.summary : `Failed: ${step.summary}`}</em>
          </li>
        ))}
      </ol>
      {runtime?.fallbackLabel ? <p className="ap-fallback-label">{runtime.fallbackLabel}</p> : null}
      {runtime?.toolSelectionErrors.length ? <p className="ap-fallback-label">Tool API errors: {runtime.toolSelectionErrors.join("; ")}</p> : null}
    </div>
  );
}

function modeLabel(runtime: NonNullable<MessageRecord["runtime"]>) {
  if (runtime.investigationMode === "llm") return "Real LLM investigation";
  if (runtime.investigationMode === "llm_partial") return "Partial LLM investigation";
  if (runtime.toolSelection === "llm_fallback") return "Rule-based (LLM tool fallback)";
  return "Rule-based investigation";
}

function displayMessage(message: MessageRecord) {
  if (message.role === "user") return englishMessage(message.content, "Previous question from this investigation.");
  if (message.content?.trim()) return englishMessage(message.content, "This saved answer needs to be rebuilt from its evidence.");
  if (message.kind === "review") return "The recommendation is ready for human review. No campaign change has been executed.";
  return "No additional performance result was returned for this question.";
}

function englishMessage(value: string | null | undefined, fallback: string) {
  if (!value?.trim() || hasChinese(value)) return fallback;
  return value;
}

function displayReason(value: string) {
  return hasChinese(value) ? "Use a cautious review step because the available data does not establish a root cause." : value;
}

function englishEvidenceLabel(value: string) {
  const labels: Record<string, string> = { "曝光": "Impressions", "点击": "Clicks", "点击率": "CTR", "转化": "Conversion-linked clicks", "转化关联点击": "Conversion-linked clicks", Conversions: "Conversion-linked clicks", "Conversion-linked clicks": "Conversion-linked clicks", "点击后转化率": "Post-click conversion-link rate", "点击后转化关联率": "Post-click conversion-link rate", "Post-click CVR": "Post-click conversion-link rate", "归因转化": "Attributed conversion links", "Attributed conversions": "Attributed conversion links", "成本指数": "Cost index", "成本指数总值": "Cost index total", "单次点击成本指数": "Average cost index per click", "归因占比": "Attribution-link share" };
  return labels[value] || (hasChinese(value) || value.includes("original Chinese copy") ? "Metric" : value);
}

function displayEvidenceValue(item: MessageRecord["evidence"][number]) {
  if (item.value !== item.relative) return item.value;
  const current = item.source.match(/(?:^| · )Current ([^·]+?)(?= · Prior|$)/)?.[1]?.trim();
  return current || item.value;
}

function hasChinese(value: string) { return /[\u3400-\u9fff]/.test(value); }

function localMessage(conversationId: string, role: "user" | "assistant", content: string, clientKey: string, status: MessageRecord["status"]): MessageRecord {
  return {
    id: clientKey,
    conversationId,
    role,
    content,
    status,
    clientKey,
    evidence: [],
    sections: [],
    series: null,
    tools: [],
    steps: [],
    statusTrail: [],
    investigation: null,
    revision: null,
    kind: "chat",
    reviewReady: false,
    mode: null,
    runtime: null,
    note: null,
    error: null,
    recoveryState: "none",
    createdAt: new Date().toISOString(),
  };
}

function mergePair(current: MessageRecord[], user: MessageRecord, assistant: MessageRecord) {
  const rest = current.filter((item) => item.clientKey !== user.clientKey && item.clientKey !== assistant.clientKey && item.id !== user.id && item.id !== assistant.id);
  return [...rest, user, assistant];
}

function userKey(assistantKey: string | null) {
  return (assistantKey || "").replace(/:assistant$/, "");
}

function pairedUser(messages: MessageRecord[], assistant: MessageRecord) {
  const key = userKey(assistant.clientKey);
  return messages.find((item) => item.clientKey === key)?.content || "";
}

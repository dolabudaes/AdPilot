"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/clientApi";
import { englishProposalText, isLostEnglishCopy } from "@/lib/copilot/english-copy";
import { ACTION_LABEL, FINDING_LABEL, STATUS_LABEL } from "@/lib/copilot/labels";
import type { Role } from "@/lib/copilot/permissions";
import type { ConversationRecord, MessageRecord } from "@/lib/copilot/conversations";
import type { DecisionView, StrategyVersion } from "@/lib/copilot/types";
import { debugDecision } from "@/lib/copilot/debug";
import { decisionCopy, decisionEventAt, keyMetrics, severityLabel } from "@/lib/copilot/decision-copy";
import { createLatestGuard } from "@/lib/copilot/metrics";
import { decisionStatusCounts, decisionsHref, resolveDecisionSelection } from "@/lib/copilot/decision-selection";
import { snapshotsMatch } from "@/lib/copilot/pin-window";
import { formatWindowRange } from "@/lib/copilot/windows";

type Context = { conversation: ConversationRecord | null; reports: Array<{ id: string; title: string; createdAt: string }>; versions: StrategyVersion[]; messages: MessageRecord[] };
type DraftFields = { title: string; reason: string; verificationSteps: string; userNotes: string };

const FILTERS = [["all", "All"], ["draft", "Draft"], ["confirmed", "Confirmed"], ["dismissed", "Dismissed"]] as const;
const AUDIT: Record<string, string> = { edit: "Recommendation edited", confirm: "Confirmed", dismiss: "Dismissed", export: "Decision record exported", draft: "Draft opened", revise: "Revision opened", submit: "Confirmed", approve: "Confirmed", reject: "Dismissed", request_changes: "Returned to draft", withdraw: "Returned to draft", reopen: "Draft reopened", mark_external: "External note recorded", expire: "Returned to draft" };

export function DecisionScreen({ decisions, role: _role, status, selectedId, campaignId, filterWindow, investigationContexts, currentDatasetVersion, currentGeneratedAt }: { decisions: DecisionView[]; role: Role; status: string; selectedId?: string | null; campaignId?: string | null; filterWindow?: string | null; investigationContexts: Record<string, Context>; currentDatasetVersion?: string | null; currentGeneratedAt?: string | null }) {
  const router = useRouter();
  const [rows, setRows] = useState(decisions);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissalReason, setDismissalReason] = useState("");
  const requestGuard = useMemo(() => createLatestGuard(), []);
  const selectedIdRef = useRef(selectedId || null);
  selectedIdRef.current = selectedId || null;
  const counts = decisionStatusCounts({ decisions: rows, campaignId, filterWindow });
  const resolved = resolveDecisionSelection({ decisions: rows, status, selectedId, campaignId, filterWindow, holdUntilRedirect: true });
  const visible = resolved.visible;
  const selected = resolved.selected;
  const context = selected ? investigationContexts[selected.id] : null;
  const copy = selected ? decisionCopy(selected, context?.messages || []) : null;
  const snapshotMismatch = Boolean(selected && !snapshotsMatch(selected.datasetVersion, [currentDatasetVersion, currentGeneratedAt]));
  const same = selected
    ? selected.original.actionType === selected.current.actionType && decisionReason(selected.original.reason) === decisionReason(selected.current.reason)
    : true;
  const windowText = selected ? formatWindowRange({ label: selected.windowLabel, compareLabel: selected.compareLabel }) || selected.windowLabel || selected.windowId : "";
  const metrics = selected ? keyMetrics(selected) : [];
  const verifyItems = (copy?.unverifiedItems || []).filter((item) => !/human-review queue|not an advertising-platform priority/i.test(item)).slice(0, 3);

  useEffect(() => {
    setRows(decisions);
  }, [decisions]);

  useEffect(() => {
    setEditing(false);
    setDismissing(false);
    setMessage("");
    debugDecision("select", { decisionId: selectedId || null, status, campaignId, windowId: filterWindow });
  }, [selectedId, status, campaignId, filterWindow]);

  function upsertDecision(next: DecisionView) {
    setRows((current) => {
      const index = current.findIndex((item) => item.id === next.id);
      if (index < 0) return [next, ...current];
      return current.map((item) => (item.id === next.id ? { ...item, ...next } : item));
    });
  }

  function storedDraft(decision: DecisionView): DraftFields {
    return {
      title: decision.current.title,
      reason: decision.current.reason,
      verificationSteps: decision.verificationSteps.trim() || (copy?.unverifiedItems.join("\n") || ""),
      userNotes: decision.userNotes,
    };
  }

  async function saveDraft(decisionId: string, body: DraftFields) {
    const token = requestGuard.next();
    setBusy(true); setMessage("");
    debugDecision("request", { requestId: token, decisionId, path: "PATCH" });
    try {
      const result = await fetchJson<{ decision?: DecisionView }>(`/api/decisions/${encodeURIComponent(decisionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!requestGuard.isCurrent(token) || selectedIdRef.current !== decisionId) return;
      if (result.decision) upsertDecision(result.decision);
      setMessage("Draft saved. It is not confirmed until you confirm the decision.");
      setEditing(false);
      debugDecision("invalidate", { requestId: token, decisionId, event: "draft-saved" });
    } catch (error) {
      if (!requestGuard.isCurrent(token)) return;
      setMessage(error instanceof Error ? error.message : "The draft could not be saved.");
    } finally {
      if (requestGuard.isCurrent(token)) setBusy(false);
    }
  }

  async function act(decisionId: string, path: string, body?: unknown) {
    const token = requestGuard.next();
    setBusy(true); setMessage("");
    debugDecision("request", { requestId: token, decisionId, path });
    try {
      const result = await fetchJson<{ document?: string; decision?: DecisionView }>(path, { method: path.includes("?") ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      if (!requestGuard.isCurrent(token)) return;
      if (result.document) download(result.document);
      if (result.decision) upsertDecision(result.decision);
      if (result.decision?.id && result.decision.id !== decisionId) {
        router.push(decisionsHref({ status, id: result.decision.id, campaignId, window: filterWindow }));
      }
      debugDecision("invalidate", { requestId: token, decisionId: result.decision?.id || decisionId, event: "mutated" });
    } catch (error) {
      if (!requestGuard.isCurrent(token)) return;
      setMessage(error instanceof Error ? error.message : "The operation failed.");
    } finally {
      if (requestGuard.isCurrent(token)) setBusy(false);
    }
  }

  async function commitThenAct(decisionId: string, body: DraftFields, path: string) {
    const token = requestGuard.next();
    setBusy(true); setMessage("");
    debugDecision("request", { requestId: token, decisionId, path: "commit-then-act" });
    try {
      const patched = await fetchJson<{ decision?: DecisionView }>(`/api/decisions/${encodeURIComponent(decisionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!requestGuard.isCurrent(token) || selectedIdRef.current !== decisionId) return;
      if (patched.decision) upsertDecision(patched.decision);
      const result = await fetchJson<{ document?: string; decision?: DecisionView }>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!requestGuard.isCurrent(token) || selectedIdRef.current !== decisionId) return;
      if (result.document) download(result.document);
      if (result.decision) upsertDecision(result.decision);
      setEditing(false);
      if (result.decision?.id && result.decision.id !== decisionId) {
        router.push(decisionsHref({ status, id: result.decision.id, campaignId, window: filterWindow }));
      }
      debugDecision("invalidate", { requestId: token, decisionId: result.decision?.id || decisionId, event: "committed" });
    } catch (error) {
      if (!requestGuard.isCurrent(token)) return;
      setMessage(error instanceof Error ? error.message : "The operation failed.");
    } finally {
      if (requestGuard.isCurrent(token)) setBusy(false);
    }
  }

  async function previewReport(conversationId: string, reportId: string) {
    setMessage("");
    try {
      const result = await fetchJson<{ report: { html: string } }>(`/api/conversations/${encodeURIComponent(conversationId)}/report?reportId=${encodeURIComponent(reportId)}`);
      const url = URL.createObjectURL(new Blob([result.report.html], { type: "text/html;charset=utf-8" }));
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The report could not be opened.");
    }
  }

  return <main className="ap-decisions-page">
    <header className="ap-decisions-header"><h1>Decisions</h1></header>
    <nav className="ap-decision-filters" aria-label="Decision status">{FILTERS.map(([id, label]) => {
      const keep = selected && (id === "all" || selected.status === id);
      const count = counts[id];
      return <a key={id} className={status === id ? "is-active" : ""} href={decisionsHref({ status: id, id: keep ? selected.id : null, campaignId, window: filterWindow })}>{label}<span>{count}</span></a>;
    })}</nav>
    <div className="ap-decision-layout">
      <aside className="ap-decision-list">
        <div className="ap-list-title"><span>Decisions</span><small>{status === "all" ? visible.length : `${visible.length} of ${counts.all}`}</small></div>
        {visible.map((item) => {
          const itemCopy = decisionCopy(item, investigationContexts[item.id]?.messages || []);
          return (
            <button key={item.id} className={selected?.id === item.id ? "is-active" : ""} onClick={() => router.push(decisionsHref({ status, id: item.id, campaignId, window: filterWindow }))}>
              <div className="ap-decision-list-row1"><strong>{item.campaignName}</strong><span>{STATUS_LABEL[item.status]}</span></div>
              <p title={itemCopy.listSignal}>{itemCopy.listSignal}</p>
              <div className="ap-decision-list-meta">
                <span>{formatWindowRange({ label: item.windowLabel, compareLabel: item.compareLabel }) || item.windowId || "Window not recorded"}</span>
                <time dateTime={decisionEventAt(item)}>{new Date(decisionEventAt(item)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</time>
              </div>
            </button>
          );
        })}
        {!visible.length ? <p className="ap-empty-inline">No decisions match this status.</p> : null}
      </aside>
      <section className="ap-decision-detail" key={selected?.id || "empty"}>{selected && copy ? <>
        <header>
          <div>
            <div className="ap-decision-head-row">
              <h2>{selected.campaignName}</h2>
              <p className="ap-decision-head-status">{[severityLabel(selected), STATUS_LABEL[selected.status]].filter(Boolean).join(" · ")}</p>
            </div>
            <p className="ap-decision-head-meta">{[windowText, selected.findingType ? FINDING_LABEL[selected.findingType] : null].filter(Boolean).join(" · ")}</p>
            {selected.parentDecisionId ? <p className="ap-decision-head-meta">Revision of a confirmed record</p> : null}
          </div>
        </header>
        {metrics.length ? (
          <section className="ap-decision-metrics" aria-label="Key metrics">
            {metrics.map((item) => (
              <article key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                {item.detail ? <small>{item.detail}</small> : null}
              </article>
            ))}
          </section>
        ) : null}
        <section className="ap-decision-split">
          {selected.status === "dismissed" ? (
            <div className="ap-decision-recommend">
              <h3>User decision</h3>
              <p className="ap-decision-recommend-action">{copy.status}</p>
              {selected.dismissalReason ? <p>Reason: {selected.dismissalReason}</p> : null}
            </div>
          ) : (
            <div className="ap-decision-recommend">
              <h3>Recommended action</h3>
              <p className="ap-decision-recommend-action">{copy.action}</p>
              <p>{copy.rationale}</p>
            </div>
          )}
          <div className="ap-decision-verify">
            <h3>{selected.status === "dismissed" ? "Original recommendation" : "What to verify"}</h3>
            {selected.status === "dismissed" ? (
              <>
                <p className="ap-decision-recommend-action">{copy.action}</p>
                <p>{copy.rationale}</p>
              </>
            ) : verifyItems.length ? <ul>{verifyItems.map((item) => <li key={item}>{item}</li>)}</ul> : <p>No additional verification steps were recorded.</p>}
          </div>
        </section>
        <section className="ap-decision-footer">
          <p className="ap-decision-footer-status">{copy.status}{selected.status === "confirmed" && selected.userNotes ? ` · ${selected.userNotes}` : ""}</p>
          <div>
            {selected.status === "draft" ? <>
              <button className="ap-btn" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
              <button className="ap-btn primary" disabled={busy} onClick={() => void commitThenAct(selected.id, storedDraft(selected), `/api/decisions/${encodeURIComponent(selected.id)}/confirm`)}>Confirm Decision</button>
              <button className="ap-btn danger" disabled={busy} onClick={() => { setDismissalReason(""); setDismissing(true); }}>Dismiss</button>
            </> : null}
            {selected.status === "confirmed" ? <>
              <button className="ap-btn primary" disabled={busy} onClick={() => void act(selected.id, `/api/decisions/${encodeURIComponent(selected.id)}/export`)}>Export Record</button>
              <button className="ap-btn" disabled={busy} onClick={() => void act(selected.id, `/api/decisions/${encodeURIComponent(selected.id)}/revise`)}>Create Revision</button>
            </> : null}
          </div>
        </section>
        <details className="ap-decision-disclosure">
          <summary>
            <span>Evidence &amp; History</span>
            <span>{selected.current.evidence.length} metrics · Expand</span>
          </summary>
          <div className="ap-decision-history">
            {copy.recordedTitle && !isLostEnglishCopy(copy.recordedTitle) && copy.recordedTitle !== copy.action ? <p><strong>Recorded title</strong> {copy.recordedTitle}</p> : null}
            {selected.current.evidence.length ? <ul className="ap-decision-evidence">{selected.current.evidence.slice(0, 8).map((item, index) => <li key={`${item.label}-${item.value}`}><strong>{decisionEvidenceLabel(item.label, item.value, index)}</strong><span>{item.value}{item.baseline ? ` · prior ${item.baseline}` : ""}{item.delta ? ` · ${item.delta}` : ""}</span></li>)}</ul> : <p>No structured evidence was saved with this decision.</p>}
            <RecordedTimes decision={selected} />
            {snapshotMismatch ? <p>Saved evidence is from a different snapshot.</p> : null}
            {context?.conversation ? <p><a href={workspaceHref(context.conversation, selected.id)}>View investigation</a></p> : null}
            <InvestigationTrail messages={context?.messages || []} steps={selected.investigationTrail || []} />
            {context?.versions.length ? <section className="ap-linked-artifacts">{context.versions.slice(0, 4).map((version) => <div key={version.id}><strong>Version {version.versionNumber}</strong><span>{ACTION_LABEL[version.proposal.actionType]}</span><time>{new Date(version.createdAt).toLocaleString("en-US")}</time></div>)}</section> : null}
            {context?.conversation ? context.reports.map((report) => <button className="ap-report-link" key={report.id} type="button" onClick={() => void previewReport(context.conversation!.id, report.id)}>Open saved investigation report</button>) : null}
            {!same ? <div className="ap-formal-diff"><article><span>Original</span><strong>{ACTION_LABEL[selected.original.actionType]}</strong><p>{decisionReason(selected.original.reason)}</p></article><article><span>Final</span><strong>{ACTION_LABEL[selected.current.actionType]}</strong><p>{decisionReason(selected.current.reason)}</p></article></div> : null}
            <ol className="ap-timeline">{[...selected.audit].reverse().map((event) => {
              const detail = auditDetail(event.action, event.detail);
              return <li key={event.id}><i /><div><strong>{AUDIT[event.action] || event.action}</strong><span>{actorLabel(event.actorName)} · {new Date(event.createdAt).toLocaleString("en-US")}</span>{detail ? <p>{detail}</p> : null}</div></li>;
            })}</ol>
          </div>
        </details>
        {message ? <p className="ap-error-text">{message}</p> : null}
        {editing && selected.status === "draft" ? (
          <DraftEditor
            key={selected.id}
            decision={selected}
            suggestedSteps={selected.verificationSteps.trim() || copy.unverifiedItems.join("\n")}
            busy={busy}
            onClose={() => setEditing(false)}
            onSave={(body) => saveDraft(selected.id, body)}
          />
        ) : null}
      </> : <div className="ap-empty-inline">{visible.length ? (selectedId && !selected ? "Loading the selected decision…" : "Select a decision to inspect its history.") : "No decisions match this filter."}</div>}</section>
      {dismissing && selected?.status === "draft" ? (
        <DismissDialog
          title={copy?.action || selected.campaignName}
          reason={dismissalReason}
          busy={busy}
          onReason={setDismissalReason}
          onCancel={() => setDismissing(false)}
          onConfirm={() => {
            setDismissing(false);
            void act(selected.id, `/api/decisions/${encodeURIComponent(selected.id)}/dismiss`, { reason: dismissalReason });
          }}
        />
      ) : null}
    </div>
  </main>;
}

function DraftEditor({
  decision,
  suggestedSteps,
  busy,
  onClose,
  onSave,
}: {
  decision: DecisionView;
  suggestedSteps: string;
  busy: boolean;
  onClose: () => void;
  onSave: (body: DraftFields) => Promise<void>;
}) {
  const [title, setTitle] = useState(decision.current.title);
  const [reason, setReason] = useState(decision.current.reason);
  const [steps, setSteps] = useState(decision.verificationSteps.trim() ? decision.verificationSteps : suggestedSteps);
  const [notes, setNotes] = useState(decision.userNotes);
  const dirty = useMemo(() => (
    title !== decision.current.title
    || reason !== decision.current.reason
    || steps !== (decision.verificationSteps.trim() ? decision.verificationSteps : suggestedSteps)
    || notes !== decision.userNotes
  ), [title, reason, steps, notes, decision, suggestedSteps]);

  function requestClose() {
    if (dirty && !window.confirm("Discard unsaved edits?")) return;
    onClose();
  }

  return (
    <div className="ap-decision-drawer">
      <button type="button" className="ap-decision-drawer-scrim" aria-label="Close editor" onClick={requestClose} />
      <aside className="ap-decision-drawer-panel" role="dialog" aria-labelledby="ap-decision-edit-title">
        <header>
          <h3 id="ap-decision-edit-title">Edit recommendation</h3>
          <button type="button" className="ap-btn" onClick={requestClose}>Close</button>
        </header>
        <label><span>Recommendation title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>Recommendation reason</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={6} /></label>
        <label><span>Manual verification steps</span><textarea value={steps} onChange={(event) => setSteps(event.target.value)} rows={4} /></label>
        <label><span>User notes <em>optional</em></span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></label>
        {dirty ? <p className="ap-decision-dirty">You have unsaved edits. Save before confirming this decision.</p> : null}
        <div>
          <button className="ap-btn primary" disabled={busy} onClick={() => void onSave({ title, reason, verificationSteps: steps, userNotes: notes })}>Save draft</button>
          <button className="ap-btn" disabled={busy} onClick={requestClose}>Cancel</button>
        </div>
      </aside>
    </div>
  );
}

function DismissDialog({
  title,
  reason,
  busy,
  onReason,
  onCancel,
  onConfirm,
}: {
  title: string;
  reason: string;
  busy: boolean;
  onReason: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="ap-confirm" role="presentation">
      <button type="button" className="ap-confirm-scrim" aria-label="Cancel dismiss" disabled={busy} onClick={onCancel} />
      <div className="ap-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="ap-dismiss-title">
        <div className="ap-confirm-copy">
          <h2 id="ap-dismiss-title">Dismiss this decision?</h2>
          <p>{title}</p>
          <label className="ap-dismiss-reason">
            <span>Dismissal reason <em>optional</em></span>
            <textarea value={reason} onChange={(event) => onReason(event.target.value)} rows={4} placeholder="Why is this recommendation being dismissed?" />
          </label>
        </div>
        <div className="ap-confirm-actions">
          <button type="button" className="ap-btn" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="ap-btn danger" disabled={busy} onClick={onConfirm}>{busy ? "Dismissing…" : "Dismiss Decision"}</button>
        </div>
      </div>
    </div>
  );
}

function InvestigationTrail({ messages, steps }: { messages: MessageRecord[]; steps: Array<{ id: string; label: string }> }) {
  const recorded = steps.length ? steps : [];
  const turns = messages.filter((item) => item.role === "user" || (item.role === "assistant" && item.status === "completed" && item.content.trim()));
  if (!recorded.length && !turns.length) return null;
  return (
    <details className="ap-investigation-trail">
      <summary>Investigation trail</summary>
      {recorded.length ? (
        <ol>
          {recorded.map((item) => (
            <li key={item.id}><strong>{item.label}</strong></li>
          ))}
        </ol>
      ) : null}
      {turns.length ? (
        <details>
          <summary>Conversation turns</summary>
          <ol>
            {turns.map((item) => (
              <li key={item.id}>
                <strong>{item.role === "user" ? "User" : "Investigation"}</strong>
                <p>{item.content.replace(/\s+/g, " ").slice(0, 420)}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </details>
  );
}

function RecordedTimes({ decision }: { decision: DecisionView }) {
  const stamp = (value: string | null) => value ? new Date(value).toLocaleString("en-US") : null;
  const rows: Array<{ label: string; value: string; title?: string }> = [
    { label: "Created", value: stamp(decision.createdAt) || "" },
    { label: "Last modified", value: decision.updatedAt && decision.updatedAt !== decision.createdAt ? stamp(decision.updatedAt) || "" : "" },
    { label: "Confirmed", value: stamp(decision.confirmedAt) || "", title: decision.timelineNote || undefined },
    { label: "Dismissed", value: stamp(decision.dismissedAt) || "" },
    { label: "Exported", value: stamp(decision.exportedAt) || "" },
  ].filter((item) => item.value);
  if (!rows.length) return null;
  return (
    <div className="ap-decision-timestamps-wrap">
      <h4>Recorded times</h4>
      <ul className="ap-decision-timestamps">{rows.map((item) => <li key={item.label} title={item.title}><strong>{item.label}</strong><span>{item.value}</span></li>)}</ul>
    </div>
  );
}

function workspaceHref(conversation: ConversationRecord, decisionId: string) { const params = new URLSearchParams({ account: conversation.accountId, window: conversation.windowId, conversation: conversation.id, decision: decisionId, view: "discuss" }); if (conversation.findingId) params.set("finding", conversation.findingId); if (conversation.campaignId) params.set("campaign", conversation.campaignId); return `/workspace?${params.toString()}`; }
function hasChinese(value: string) { return /[\u3400-\u9fff]/.test(value); }
function englishText(value: string, fallback: string) { return value && !hasChinese(value) ? value : fallback; }
function decisionReason(value: string) { if (!value?.trim()) return "No rationale was recorded for this decision."; return englishProposalText(value) || value; }
function decisionEvidenceLabel(value: string, metricValue = "", index = 0) {
  const labels: Record<string, string> = { "曝光": "Impressions", "点击": "Clicks", "转化": "Conversion-linked clicks", "转化关联点击": "Conversion-linked clicks", Conversions: "Conversion-linked clicks", "点击后转化率": "Conversion-link rate", "点击后转化关联率": "Conversion-link rate", "Post-click conversion-link rate": "Conversion-link rate", "Post-click CVR": "Conversion-link rate", "点击率": "CTR", "单次点击成本指数": "Average cost index per click", "成本指数": "Cost index", "成本指数总值": "Cost index total", "归因转化": "Attributed links", "Attributed conversions": "Attributed links", "Attributed conversion links": "Attributed links" };
  if (labels[value]) return labels[value];
  if (isLostEnglishCopy(value) || hasChinese(value)) {
    if (/%/.test(metricValue)) return "Conversion-link rate";
    const inferred = ["Clicks", "Conversion-linked clicks", "Conversion-link rate", "Cost index"][index];
    return inferred || "Metric";
  }
  return englishText(value, "Metric");
}
function auditDetail(action: string, value: string) {
  const text = englishText(value, "");
  return text
    .replace(/\s*(?:Confirmation is not platform execution|This is not (?:advertising-)?platform execution)\.?/gi, "")
    .replace(/\s*This is not advertising-platform execution\.?/gi, "")
    .trim();
}
function actorLabel(value: string) { const labels: Record<string,string> = { "查看者": "Viewer", "优化师": "Analyst", "审批人": "Approver", "管理员": "Administrator" }; return labels[value] || englishText(value, "Workspace user"); }
function download(text: string) { const blob = new Blob([text], { type: "text/plain;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "adpilot-decision-record.txt"; link.click(); URL.revokeObjectURL(url); }

"use client";

import { FormEvent, useState } from "react";
import { can, type Role } from "@/lib/copilot/permissions";

export type InvestigationStarter = { label: string; question: string; campaignId: string | null };

export function NewInvestigationCompose({
  role,
  campaigns,
  windows,
  defaultCampaignId,
  defaultWindowId,
  busy,
  notice,
  starters,
  onSubmit,
}: {
  role: Role;
  campaigns: Array<{ id: string; name: string }>;
  windows: Array<{ id: string; label: string }>;
  defaultCampaignId?: string | null;
  defaultWindowId: string;
  busy: boolean;
  notice?: string;
  starters: InvestigationStarter[];
  onSubmit: (input: { question: string; campaignScope: string; windowId: string }) => void;
}) {
  const [question, setQuestion] = useState("");
  const [campaignScope, setCampaignScope] = useState(defaultCampaignId || "all");
  const [windowId, setWindowId] = useState(defaultWindowId);
  const canSend = can(role, "converse");

  function send(text: string, scope = campaignScope) {
    const value = text.trim();
    if (!value || busy || !canSend) return;
    onSubmit({ question: value, campaignScope: scope, windowId });
  }

  function onForm(event: FormEvent) {
    event.preventDefault();
    send(question);
  }

  return (
    <div className="ap-ws-compose">
      <h1>What would you like to investigate?</h1>
      <form className="ap-ws-compose-card" onSubmit={onForm}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about performance, trends, or a specific campaign…"
          disabled={!canSend || busy}
          rows={2}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(question);
            }
          }}
        />
        <div className="ap-ws-compose-bar">
          <label>
            <span>Campaign</span>
            <select aria-label="Campaign scope" value={campaignScope} onChange={(e) => setCampaignScope(e.target.value)} disabled={busy}>
              <option value="all">All campaigns</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>
            <span>Date range</span>
            <select aria-label="Date range" value={windowId} onChange={(e) => setWindowId(e.target.value)} disabled={busy}>
              {windows.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
          <button type="submit" className="ap-btn primary" disabled={!canSend || busy || !question.trim()}>
            {busy ? "Starting…" : "Send"}
          </button>
        </div>
      </form>
      {notice ? <p className="ap-error-text ap-ws-notice">{notice}</p> : null}
      <section className="ap-ws-starters" aria-label="Suggested investigations">
        <div><h2>Suggested investigations</h2></div>
        {starters.map((starter) => (
          <button key={`${starter.campaignId || "account"}-${starter.question}`} type="button" disabled={!canSend || busy} onClick={() => {
            const scope = starter.campaignId || "all";
            setCampaignScope(scope);
            send(starter.question, scope);
          }}>
            <span>{starter.campaignId || "Account-wide"}</span>
            <strong>{starter.label}</strong>
          </button>
        ))}
      </section>
    </div>
  );
}

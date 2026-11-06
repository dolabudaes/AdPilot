"use client";

import { useMemo, useState } from "react";
import { EmptyState, emptyCopy } from "@/components/copilot/states";
import { campaignMatchesDecisionFilter, summarizeCampaignDecisions } from "@/lib/copilot/campaign-decisions";
import { buildWorkspaceUrl } from "@/lib/copilot/workspace-nav";
import { FINDING_LABEL, METRIC_HINT, SEVERITY_LABEL, formatCount, formatRate } from "@/lib/copilot/labels";
import type { ConversationRecord } from "@/lib/copilot/conversations";
import type { Role } from "@/lib/copilot/permissions";
import type { CampaignRow, DecisionView, ProductModel } from "@/lib/copilot/types";
import { formatWindowRange } from "@/lib/copilot/windows";

type SignalFilter = "all" | "signal" | "stable";
type PriorityFilter = "all" | "high" | "medium" | "low";
type DecisionFilter = "all" | "none" | "draft" | "confirmed" | "dismissed";
type DecisionHistory = "window" | "all";

export function CampaignsScreen({
  model,
  initialCampaignId,
  conversations,
  decisions,
}: {
  model: ProductModel;
  role: Role;
  initialCampaignId?: string | null;
  conversations?: ConversationRecord[];
  decisions?: DecisionView[];
}) {
  const empty = emptyCopy(model.emptyReason);
  const [query, setQuery] = useState("");
  const [signalFilter, setSignalFilter] = useState<SignalFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [decisionHistory, setDecisionHistory] = useState<DecisionHistory>("window");
  const [sort, setSort] = useState<"name" | "clicks" | "cvr" | "conversions">("clicks");
  const decisionRows = decisions || [];
  const defaultWindow = model.window?.id || "recent_7d";
  const scopedDecisions = decisionHistory === "window" ? decisionRows.filter((item) => item.windowId === defaultWindow) : decisionRows;

  const rows = useMemo(() => {
    return [...model.campaigns]
      .filter((row) => !query || row.name.toLowerCase().includes(query.toLowerCase()))
      .filter((row) => {
        if (signalFilter === "signal") return Boolean(row.findingType);
        if (signalFilter === "stable") return !row.findingType;
        return true;
      })
      .filter((row) => priorityFilter === "all" || row.severity === priorityFilter)
      .filter((row) => campaignMatchesDecisionFilter(scopedDecisions, row.id, decisionFilter, decisionHistory === "window" ? defaultWindow : null))
      .sort((a, b) => compareRows(a, b, sort));
  }, [model.campaigns, query, signalFilter, priorityFilter, decisionFilter, sort, scopedDecisions, decisionHistory, defaultWindow]);

  if (!model.ready && empty) return <EmptyState title={empty.title} body={empty.body} action={{ href: empty.href, label: empty.label }} />;

  return (
    <main className="ap-campaigns-page">
      <header className="ap-page-head compact">
        <div>
          <h1>All campaigns</h1>
          {formatWindowRange(model.window) ? <p className="ap-muted">{formatWindowRange(model.window)}</p> : null}
        </div>
      </header>
      <div className="ap-table-tools">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search campaigns" aria-label="Search campaigns" />
        <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="Sort campaigns">
          <option value="clicks">Sort: Clicks</option>
          <option value="conversions">Sort: Conversion-linked clicks</option>
          <option value="cvr">Sort: Conversion-link rate</option>
          <option value="name">Sort: Name</option>
        </select>
        <select value={signalFilter} onChange={(event) => setSignalFilter(event.target.value as SignalFilter)} aria-label="Signal filter">
          <option value="all">All signals</option>
          <option value="signal">With signal</option>
          <option value="stable">Stable</option>
        </select>
        <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as PriorityFilter)} aria-label="Priority filter">
          <option value="all">All priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value as DecisionFilter)} aria-label="Decision filter">
          <option value="all">All decisions</option>
          <option value="none">No decision</option>
          <option value="draft">Draft</option>
          <option value="confirmed">Confirmed</option>
          <option value="dismissed">Dismissed</option>
        </select>
        <select value={decisionHistory} onChange={(event) => setDecisionHistory(event.target.value as DecisionHistory)} aria-label="Decision window scope">
          <option value="window">This analysis window</option>
          <option value="all">All history</option>
        </select>
      </div>
      <div className="ap-campaign-table-wrap">
        <table className="ap-campaign-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th className="ap-num" title={METRIC_HINT.clicks}>Clicks</th>
              <th className="ap-num" title={METRIC_HINT.conversions}>Conversion-linked clicks</th>
              <th className="ap-num" title={METRIC_HINT.ctr}>CTR</th>
              <th className="ap-num" title={METRIC_HINT.cvr}>Conversion-link rate</th>
              <th>Signal</th>
              <th>Priority</th>
              <th>Decision</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const thread =
                conversations?.find((item) => row.findingId && item.findingId === row.findingId) ||
                (!row.findingId ? conversations?.find((item) => item.campaignId === row.id && item.windowId === defaultWindow) : null) ||
                null;
              const href = row.findingId
                ? buildWorkspaceUrl({
                    accountId: model.account.id,
                    windowId: thread?.windowId || defaultWindow,
                    findingId: row.findingId,
                    campaignId: row.id,
                    conversationId: thread?.id || null,
                  })
                : buildWorkspaceUrl({
                    accountId: model.account.id,
                    windowId: thread?.windowId || defaultWindow,
                    campaignId: row.id,
                    conversationId: thread?.id || null,
                    view: thread ? "discuss" : "compose",
                  });
              const hasThread = Boolean(thread);
              const highlight = initialCampaignId === row.id;
              const decision = summarizeCampaignDecisions(decisionRows, row.id, { windowId: defaultWindow, history: decisionHistory });
              const decided = decision.key === "confirmed" || decision.key === "dismissed";
              const actionHref = decided && decision.href ? decision.href : href;
              const actionLabel = decided
                ? "View decision"
                : hasThread
                  ? "Continue investigation"
                  : row.findingId
                    ? "Investigate"
                    : "Start investigation";
              return (
                <tr key={row.id} className={highlight ? "is-selected" : ""}>
                  <td><a href={href}><strong>{row.name}</strong></a></td>
                  <td className="ap-num">{formatCount(row.clicks)}</td>
                  <td className="ap-num">{formatCount(row.conversions)}</td>
                  <td className="ap-num">{formatRate(row.ctr)}</td>
                  <td className="ap-num">{formatRate(row.cvr)}</td>
                  <td>{row.findingType ? FINDING_LABEL[row.findingType] : <span className="ap-muted">No active signal</span>}</td>
                  <td>{row.severity ? <span className={`ap-severity ${row.severity}`}>{SEVERITY_LABEL[row.severity]}</span> : "—"}</td>
                  <td>
                    {decision.href ? <a href={decision.href}>{decision.label}</a> : decision.label}
                  </td>
                  <td><a className="ap-btn compact" href={actionHref}>{actionLabel}</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length ? <p className="ap-empty-inline">No campaigns match these filters.</p> : null}
      </div>
    </main>
  );
}

function compareRows(a: CampaignRow, b: CampaignRow, key: "name" | "clicks" | "cvr" | "conversions") {
  if (key === "name") return a.name.localeCompare(b.name);
  return Number(b[key] || 0) - Number(a[key] || 0);
}

"use client";

import { useEffect, useState } from "react";
import { TrendChart } from "@/components/copilot/chart";
import { EmptyState, emptyCopy } from "@/components/copilot/states";
import { fetchJson } from "@/lib/clientApi";
import { buildWorkspaceUrl } from "@/lib/copilot/workspace-nav";
import { METRIC_HINT, SEVERITY_LABEL, deltaTone, formatChange, formatCost, formatCount, formatRate, primaryChange, signalKind } from "@/lib/copilot/labels";
import { signalRuleExplanation } from "@/lib/copilot/signal-rules";
import type { FindingView, ProductModel, Role, TrendPoint } from "@/lib/copilot/types";
import { formatWindowRange } from "@/lib/copilot/windows";

type Metric = "impressions" | "clicks" | "ctr" | "conversions" | "cvr" | "attributed" | "cost";

const KPI_LABEL: Record<string, string> = {
  impressions: "Impressions",
  clicks: "Clicks",
  ctr: "CTR",
  conversions: "Conversion-linked clicks",
  cvr: "Conversion-link rate",
  attributed: "Attributed links",
  cost: "Cost index",
};

export function OverviewScreen({ model }: { model: ProductModel; role: Role }) {
  const empty = emptyCopy(model.emptyReason);
  const [metric, setMetric] = useState<Metric>("cvr");
  const [campaignId, setCampaignId] = useState("");
  const [campaignSeries, setCampaignSeries] = useState<TrendPoint[] | null>(null);

  useEffect(() => {
    if (!campaignId) { setCampaignSeries(null); return; }
    void fetchJson<{ detail: { series: TrendPoint[] } }>(`/api/campaigns/${encodeURIComponent(campaignId)}?window=${encodeURIComponent(model.window?.id || "recent_7d")}`)
      .then((result) => setCampaignSeries(result.detail.series))
      .catch(() => setCampaignSeries(null));
  }, [campaignId, model.window?.id]);

  if (!model.ready && empty) return <EmptyState title={empty.title} body={empty.body} action={{ href: empty.href, label: empty.label }} />;

  const totalCampaigns = model.campaigns.length;
  const flaggedCampaigns = new Set(model.findings.map((f) => f.campaignId)).size;
  const hasCompare = Boolean(model.window?.compareLabel);
  const findings = model.findings;
  const series = campaignSeries || model.trend;
  const accountId = model.account.id;
  const windowId = model.window?.id || "recent_7d";

  return (
    <main className="ap-overview-page ap-overview-v3">
      <header className="ap-account-header">
        <div>
          <h1>{model.account.name}</h1>
          <p className="ap-account-meta">
            {[formatWindowRange(model.window) || "Window", `Imported ${model.generatedAt ? new Date(model.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "unavailable"}`].join(" · ")}
          </p>
        </div>
        <dl className="ap-account-stats">
          <div><dt>Campaigns analyzed</dt><dd>{totalCampaigns}</dd></div>
          <div><dt>Priority signals</dt><dd>{flaggedCampaigns}</dd></div>
        </dl>
      </header>

      {!hasCompare ? <p className="ap-compare-banner">No comparison period in this window. Period-over-period deltas are hidden on account KPIs.</p> : null}

      <section className="ap-kpi-compact" aria-label="Account KPIs">
        {model.kpis.filter((k) => ["clicks", "conversions", "cvr", "attributed"].includes(k.metric)).map((kpi) => (
          <article key={kpi.id}>
            <span title={METRIC_HINT[kpi.metric] || kpi.hint}>{KPI_LABEL[kpi.metric] || kpi.label}</span>
            <strong>{kpi.value}</strong>
            <em className={kpi.deltaTone}>{hasCompare ? kpi.delta : "Current window"}</em>
          </article>
        ))}
      </section>

      <div className="ap-overview-split">
        <section className="ap-attention-queue ap-signal-list-panel">
          <div className="ap-section-head">
            <div>
              <h2>Campaign signals</h2>
            </div>
            <a href={`/campaigns?account=${accountId}&window=${windowId}`}>All campaigns</a>
          </div>
          <div className="ap-signal-list-head" aria-hidden="true"><span>Campaign</span><span>Metric</span><span>Change</span><span>Signal</span><span /></div>
          <ul className="ap-attention-list">
            {findings.map((finding) => (
              <AttentionRow
                key={finding.id}
                finding={finding}
                costPerClick={(() => { const campaign = model.campaigns.find((item) => item.id === finding.campaignId); return campaign?.cost != null && campaign.clicks > 0 ? campaign.cost / campaign.clicks : null; })()}
                href={buildWorkspaceUrl({ accountId, windowId, findingId: finding.id, campaignId: finding.campaignId })}
              />
            ))}
            {!findings.length ? <li className="ap-empty-inline">No campaign signals were detected in this window.</li> : null}
          </ul>
        </section>

        <section className="ap-analytics-panel ap-account-trend-panel">
          <div className="ap-section-head">
            <h2>{campaignId ? `${model.campaigns.find((row) => row.id === campaignId)?.name || "Campaign"} trend` : "Account trend"}</h2>
            <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign scope">
              <option value="">All campaigns</option>
              {model.campaigns.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </div>
          {series.length ? <TrendChart points={series} anomalies={!campaignId && metric === "cvr" ? model.anomalies : []} metric={metric} onMetric={setMetric} summary={trendSummary(model, campaignId, metric)} currentStart={model.window?.start} currentEnd={model.window?.end} compareStart={model.window?.compareStart} compareEnd={model.window?.compareEnd} windowLabel={model.window?.label} compareLabel={model.window?.compareLabel} /> : <p className="ap-muted">No daily series available.</p>}
        </section>
      </div>
    </main>
  );
}

function AttentionRow({ finding, costPerClick, href }: { finding: FindingView; costPerClick: number | null; href: string }) {
  const change = primaryChange(finding);
  const hasFindingCompare = Boolean(finding.compareLabel && change.value != null);
  const metricValue = attentionValue(finding, change.metric, costPerClick);
  const kind = signalKind(finding.type);

  return (
    <li className="ap-attention-row">
      <a className="ap-attention-campaign" href={href}>{finding.campaignName}</a>
      <span className="ap-signal-metric"><small>{change.metric === "cost" ? "Cost index / click" : "Conversion-link rate"}</small><strong>{metricValue}</strong></span>
      <em className={`ap-signal-change ${deltaTone(change.metric, change.value)}`}>{hasFindingCompare ? formatChange(change.value) : "No baseline"}</em>
      <span
        className={`ap-signal-stack`}
        title={signalRuleExplanation(finding)}
        aria-label={`${kind.label}, ${SEVERITY_LABEL[finding.severity]}. ${signalRuleExplanation(finding)}`}
      >
        <span className={`ap-signal-class ${kind.id}`}>{kind.label}</span>
        <small>{SEVERITY_LABEL[finding.severity]}</small>
      </span>
      <a className="ap-signal-action" href={href}>Investigate</a>
    </li>
  );
}

function attentionValue(finding: FindingView, metric: string, costPerClick: number | null) {
  if (metric === "cvr") return formatRate(finding.raw.cvr);
  return formatCost(costPerClick);
}

function trendSummary(model: ProductModel, campaignId: string, metric: Metric) {
  if (!campaignId) {
    const kpi = model.kpis.find((item) => item.metric === metric);
    return {
      value: kpi?.value || "—",
      delta: model.window?.compareLabel ? kpi?.delta || "No comparison" : "No comparison window",
      tone: kpi?.deltaTone || ("neutral" as const),
      range: formatWindowRange(model.window) || "Window",
    };
  }
  const campaign = model.campaigns.find((item) => item.id === campaignId);
  const finding = model.findings.find((item) => item.campaignId === campaignId);
  const value = campaign
    ? metric === "ctr" || metric === "cvr"
      ? formatRate(campaign[metric])
      : metric === "cost"
        ? formatCost(campaign.cost)
        : formatCount(campaign[metric])
    : "—";
  const change = metric === "cvr" ? finding?.raw.cvrChangePct : metric === "clicks" ? finding?.raw.clicksChangePct : metric === "conversions" ? finding?.raw.conversionDelta : metric === "cost" ? finding?.raw.costPerClickChangePct : null;
  return {
    value,
    delta: change == null ? "Comparison unavailable" : metric === "conversions" ? `${formatCount(change)} vs comparison` : `${formatChange(change)} vs comparison`,
    tone: deltaTone(metric, change),
    range: formatWindowRange(model.window) || "Window",
  };
}

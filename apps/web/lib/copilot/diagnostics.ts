import { getCampaigns, getDailyMetrics, type DatasetMeta } from "@/lib/analytics";
import type { CampaignDailyMetric, CampaignSummary } from "@/lib/analytics/types";
import { relativeChange } from "./metrics";
import { rate, wow } from "@/lib/workbench/format";
import { FINDING_LABEL, formatChange, formatCount, formatCost, formatRate, deltaTone } from "./labels";
import type {
  CampaignStats,
  EvidenceItem,
  FindingDraft,
  FindingRaw,
  FindingType,
  Kpi,
  Severity,
  TrendAnomaly,
  TrendPoint,
  WatchItem,
} from "./types";
import type { WindowSpec } from "./windows";
import { SIGNAL_RULES } from "./signal-rules";

export const DEMO_ACCOUNT_ID = "criteo-demo";

export type Bucket = {
  impressions: number;
  clicks: number;
  conversions: number;
  attributed: number;
  cost: number;
  ctr: number | null;
  cvr: number | null;
  costPerClick: number | null;
  attributionShare: number | null;
};

export type DiagnosisResult = {
  findings: FindingDraft[];
  watchlist: WatchItem[];
  kpis: Kpi[];
  trend: TrendPoint[];
  anomalies: TrendAnomaly[];
  campaigns: CampaignStats[];
  missing: string[];
};

const MISSING = [
  "Budget, bid, and verified ad-spend fields are unavailable, so the snapshot cannot support delivery-change recommendations.",
  "Creative, landing-page, and audience fields are unavailable, so efficiency movement cannot be attributed to those factors.",
  "Cost is an undisclosed transformed index; it is not currency and cannot support percentage claims of cost improvement or deterioration.",
];

export function loadAnalysisInputs() {
  const campaigns = getCampaigns();
  const daily = getDailyMetrics();
  return { campaigns, daily };
}

export function diagnose(input: {
  accountId: string;
  window: WindowSpec;
  campaigns: CampaignSummary[];
  daily: CampaignDailyMetric[];
  minClicks: number;
  meta: DatasetMeta;
}): DiagnosisResult {
  const minClicks = Math.max(20, input.minClicks || 80);
  const source = `campaign_daily.csv · ${input.window.label}`;
  const byCampaign = new Map<string, CampaignDailyMetric[]>();
  for (const row of input.daily) {
    const list = byCampaign.get(row.campaign_id) || [];
    list.push(row);
    byCampaign.set(row.campaign_id, list);
  }

  const pairs = input.campaigns.map((campaign) => {
    const rows = byCampaign.get(campaign.campaign_id) || [];
    const current = bucket(rows.filter((row) => row.day >= input.window.start && row.day <= input.window.end));
    const previous =
      input.window.compareStart != null && input.window.compareEnd != null
        ? bucket(rows.filter((row) => row.day >= input.window.compareStart! && row.day <= input.window.compareEnd!))
        : null;
    return { campaign, rows, current, previous };
  });

  const accountCurrent = bucket(
    input.daily.filter((row) => row.day >= input.window.start && row.day <= input.window.end)
  );
  const accountPrevious =
    input.window.compareStart != null && input.window.compareEnd != null
      ? bucket(input.daily.filter((row) => row.day >= input.window.compareStart! && row.day <= input.window.compareEnd!))
      : null;

  const findings: FindingDraft[] = [];
  for (const pair of pairs) {
    const finding = classify({
      accountId: input.accountId,
      window: input.window,
      campaign: pair.campaign,
      current: pair.current,
      previous: pair.previous,
      accountCvr: accountCurrent.cvr,
      minClicks,
      source,
    });
    if (finding) findings.push(finding);
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || Math.abs(b.raw.conversionDelta || 0) - Math.abs(a.raw.conversionDelta || 0));
  const primary = findings.filter((item) => item.severity !== "info");
  const info = findings.filter((item) => item.severity === "info").slice(0, 6);
  const visible = [...primary, ...info];
  const primaryIds = new Set(primary.map((item) => item.campaignId));

  const watchlist: WatchItem[] = pairs
    .map((pair) => {
      if (!pair.previous || primaryIds.has(pair.campaign.campaign_id)) return null;
      if (pair.current.clicks < minClicks || pair.previous.clicks < minClicks) return null;
      const delta = pair.current.conversions - pair.previous.conversions;
      if (delta >= 0) return null;
      return {
        campaignId: pair.campaign.campaign_id,
        campaignName: pair.campaign.display_name,
        conversionDelta: delta,
        fact: `${pair.campaign.display_name} had ${formatCount(Math.abs(delta))} fewer conversion-linked clicks, but its post-click conversion-link rate changed ${formatChange(wow(pair.current.cvr, pair.previous.cvr))}; the combined anomaly and sample thresholds were not met.`,
      };
    })
    .filter((item): item is WatchItem => Boolean(item))
    .sort((a, b) => a.conversionDelta - b.conversionDelta)
    .slice(0, 3);

  const trend = accountTrend(input.daily, input.window);
  const anomalies = cvrAnomalies(trend);
  const kpis = buildKpis(accountCurrent, accountPrevious, trend, visible);
  const campaigns = pairs
    .map((pair) => toStats(pair.campaign, pair.current, pair.rows, input.window))
    .sort((a, b) => b.impressions - a.impressions);

  return { findings: visible, watchlist, kpis, trend, anomalies, campaigns, missing: MISSING };
}

export function sumDaily(rows: CampaignDailyMetric[]): Bucket {
  return bucket(rows);
}

function bucket(rows: CampaignDailyMetric[]): Bucket {
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const conversions = rows.reduce((sum, row) => sum + row.conversions, 0);
  const attributed = rows.reduce((sum, row) => sum + row.attributed_conversions, 0);
  const cost = rows.reduce((sum, row) => sum + row.total_cost, 0);
  return {
    impressions,
    clicks,
    conversions,
    attributed,
    cost,
    ctr: rate(clicks, impressions),
    cvr: rate(conversions, clicks),
    costPerClick: clicks > 0 ? cost / clicks : null,
    attributionShare: rate(attributed, conversions),
  };
}

function classify(input: {
  accountId: string;
  window: WindowSpec;
  campaign: CampaignSummary;
  current: Bucket;
  previous: Bucket | null;
  accountCvr: number | null;
  minClicks: number;
  source: string;
}): FindingDraft | null {
  const { campaign, current, previous, window } = input;
  if (current.impressions <= 0 && current.clicks <= 0) return null;
  const raw = toRaw(current, previous);
  const base = {
    accountId: input.accountId,
    campaignId: campaign.campaign_id,
    campaignName: campaign.display_name,
    windowId: window.id,
    windowLabel: window.label,
    compareLabel: window.compareLabel,
    source: input.source,
    raw,
    current,
    previous,
  };

  if (!previous) {
    if (current.impressions >= 2000 && current.clicks < input.minClicks) {
      return draft(base, "data_gap", "info", "Comparison window is unavailable");
    }
    if (input.accountCvr != null && current.clicks >= SIGNAL_RULES.benchmarkMinClicks && current.cvr != null && current.cvr <= input.accountCvr * SIGNAL_RULES.weakAccountBenchmarkRatio && current.cvr <= SIGNAL_RULES.weakRateCeiling) {
      return draft(base, "weak_click_efficiency", "medium", "Conversion-link rate trails the project benchmark");
    }
    return null;
  }

  if ((current.clicks < input.minClicks || previous.clicks < input.minClicks) && current.impressions >= 2000) {
    return draft(base, "data_gap", "info", "Click sample is below the diagnostic threshold");
  }
  if (current.clicks < input.minClicks || previous.clicks < input.minClicks) return null;

  const cvrChange = raw.cvrChangePct;
  const cvrDrop = current.cvr != null && previous.cvr != null ? current.cvr - previous.cvr : null;
  if (
    cvrChange != null &&
    cvrDrop != null &&
    cvrChange <= SIGNAL_RULES.declineRelativePct &&
    cvrDrop <= SIGNAL_RULES.declineAbsolutePoints &&
    (raw.conversionDelta || 0) < 0
  ) {
    const high = cvrChange <= SIGNAL_RULES.highDeclineRelativePct && current.clicks >= SIGNAL_RULES.highDeclineMinClicks && (raw.conversionDelta || 0) <= SIGNAL_RULES.highDeclineConversionDelta;
    return draft(base, "cvr_anomaly", high ? "high" : "medium", high ? "Conversion-link rate declined materially" : "Conversion-link rate is below the comparison window");
  }

  if (
    input.accountCvr != null &&
    current.clicks >= SIGNAL_RULES.benchmarkMinClicks &&
    current.cvr != null &&
    current.cvr <= input.accountCvr * SIGNAL_RULES.weakAccountBenchmarkRatio &&
    current.cvr <= SIGNAL_RULES.weakRateCeiling
  ) {
    return draft(base, "weak_click_efficiency", "medium", "Click volume is sufficient but conversion-link efficiency is weak");
  }

  if (
    current.conversions >= 30 &&
    previous.conversions >= 30 &&
    current.attributionShare != null &&
    previous.attributionShare != null &&
    (wow(current.attributionShare, previous.attributionShare) || 0) <= SIGNAL_RULES.attributionRelativePct
  ) {
    return draft(base, "attribution_anomaly", "low", "Attribution-link share declined versus the comparison window");
  }

  if (
    current.clicks >= SIGNAL_RULES.benchmarkMinClicks &&
    previous.clicks >= SIGNAL_RULES.benchmarkMinClicks &&
    cvrChange != null &&
    cvrDrop != null &&
    cvrChange >= SIGNAL_RULES.opportunityRelativePct &&
    cvrDrop >= SIGNAL_RULES.opportunityAbsolutePoints &&
    (raw.conversionDelta || 0) > 0 &&
    input.accountCvr != null &&
    current.cvr != null &&
    current.cvr >= input.accountCvr
  ) {
    return draft(base, "scale_opportunity", "medium", "Conversion-link efficiency improved versus the comparison window");
  }

  return null;
}

function toRaw(current: Bucket, previous: Bucket | null): FindingRaw {
  return {
    clicks: current.clicks,
    previousClicks: previous?.clicks ?? null,
    cvr: current.cvr,
    previousCvr: previous?.cvr ?? null,
    cvrChangePct: previous ? relativeChange(current.cvr, previous.cvr) : null,
    conversions: current.conversions,
    previousConversions: previous?.conversions ?? null,
    conversionDelta: previous ? current.conversions - previous.conversions : null,
    clicksChangePct: previous ? wow(current.clicks, previous.clicks) : null,
    costPerClickChangePct: previous ? wow(current.costPerClick, previous.costPerClick) : null,
  };
}

function draft(
  base: {
    accountId: string;
    campaignId: string;
    campaignName: string;
    windowId: string;
    windowLabel: string;
    compareLabel: string | null;
    source: string;
    raw: FindingRaw;
    current: Bucket;
    previous: Bucket | null;
  },
  type: FindingType,
  severity: Severity,
  titleTail: string
): FindingDraft {
  const name = base.campaignName;
  const evidence: EvidenceItem[] = [
    item("Clicks", formatCount(base.current.clicks), base.previous ? formatCount(base.previous.clicks) : null, formatChange(base.raw.clicksChangePct), base.source),
    item("Conversion-linked clicks", formatCount(base.current.conversions), base.previous ? formatCount(base.previous.conversions) : null, base.raw.conversionDelta == null ? null : formatCount(base.raw.conversionDelta), base.source),
    item("Post-click conversion-link rate", formatRate(base.current.cvr), base.previous ? formatRate(base.previous.cvr) : null, formatChange(base.raw.cvrChangePct), base.source),
  ];
  const fact = `${name} recorded ${formatCount(base.current.clicks)} clicks in ${base.windowLabel}; ${formatCount(base.current.conversions)} clicks carried a future 30-day conversion label, for a post-click conversion-link rate of ${formatRate(base.current.cvr)}. ${
    base.previous
      ? `The comparison window recorded ${formatCount(base.previous.clicks)} clicks, ${formatCount(base.previous.conversions)} conversion-linked clicks, and a ${formatRate(base.previous.cvr)} conversion-link rate.`
      : "No equal-length comparison window is available."
  }`;
  const interpretation =
    type === "cvr_anomaly"
      ? "Post-click conversion-link rate moved beyond the rule threshold while conversion-linked clicks also fell. Judged against this campaign's comparison window."
      : type === "weak_click_efficiency"
        ? "Click volume is sufficient, but post-click conversion-link rate trails the project benchmark and an 8% absolute floor."
        : type === "cost_rise"
          ? "Cost index per click rose without a matching CVR gain. Cost index is not verified ad spend."
          : type === "scale_opportunity"
            ? "Post-click conversion-link rate beats its own baseline and the project benchmark. This supports further efficiency validation, not an automatic budget or delivery increase."
            : type === "attribution_anomaly"
              ? "Attribution-link share fell—an attribution-mix signal, not an independent conversion-event conclusion."
              : "Sample or comparison window is too thin for a firm optimization call.";
  const hypothesis = "Budget, bids, creatives, and landing pages are not in this dataset; those angles remain unverified hypotheses.";
  return {
    id: `finding:${base.accountId}:${base.windowId}:${base.campaignId}:${type}`,
    accountId: base.accountId,
    campaignId: base.campaignId,
    campaignName: name,
    type,
    severity,
    windowId: base.windowId,
    windowLabel: base.windowLabel,
    compareLabel: base.compareLabel,
    title: `${name}: ${titleTail}`,
    summary: `${FINDING_LABEL[type]}. ${fact}`,
    fact,
    interpretation,
    hypothesis,
    evidence,
    raw: base.raw,
  };
}

function item(label: string, value: string, baseline: string | null, delta: string | null, source: string): EvidenceItem {
  return { label, value, baseline, delta, source };
}

function accountTrend(daily: CampaignDailyMetric[], window: WindowSpec): TrendPoint[] {
  const buckets = new Map<number, CampaignDailyMetric[]>();
  for (const row of daily) {
    if (row.day < window.start || row.day > window.end) continue;
    const list = buckets.get(row.day) || [];
    list.push(row);
    buckets.set(row.day, list);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, rows]) => {
      const summed = bucket(rows);
      return {
        day,
        impressions: summed.impressions,
        clicks: summed.clicks,
        conversions: summed.conversions,
        attributed: summed.attributed,
        cost: summed.cost,
        ctr: summed.ctr,
        cvr: summed.cvr,
      };
    });
}

function cvrAnomalies(trend: TrendPoint[]): TrendAnomaly[] {
  const usable = trend.filter((point) => point.clicks >= 100 && point.cvr != null);
  if (usable.length < 8) return [];
  const mean = usable.reduce((sum, point) => sum + (point.cvr || 0), 0) / usable.length;
  const variance = usable.reduce((sum, point) => sum + ((point.cvr || 0) - mean) ** 2, 0) / usable.length;
  const sd = Math.sqrt(variance);
  if (sd < 0.004) return [];
  return usable
    .map((point) => ({ point, z: ((point.cvr || 0) - mean) / sd }))
    .filter((item) => item.z <= -2)
    .sort((a, b) => a.z - b.z)
    .slice(0, 3)
    .map((item) => ({
      day: item.point.day,
      metric: "cvr" as const,
      z: Number(item.z.toFixed(2)),
      title: `D${item.point.day}: post-click conversion-link rate deviates from window mean`,
      fact: `On D${item.point.day}, account post-click conversion-link rate was ${formatRate(item.point.cvr)}, about ${Math.abs(item.z).toFixed(1)} standard deviations below the window mean. Clicks that day: ${formatCount(item.point.clicks)}. This flags a statistical deviation—not a specific campaign cut.`,
    }));
}

function buildKpis(current: Bucket, previous: Bucket | null, trend: TrendPoint[], findings: FindingDraft[]): Kpi[] {
  const related = (type: FindingDraft["type"]) => findings.find((item) => item.type === type)?.id || null;
  const rows: Array<{ id: Kpi["id"]; label: string; metric: Kpi["metric"]; value: number | null; previous: number | null; hint: string; rate?: boolean; cost?: boolean; findingId: string | null }> = [
    { id: "impressions", label: "Impressions", metric: "impressions", value: current.impressions, previous: previous?.impressions ?? null, hint: "Ad impressions in the window.", findingId: null },
    { id: "clicks", label: "Clicks", metric: "clicks", value: current.clicks, previous: previous?.clicks ?? null, hint: "Clicks in the window.", findingId: related("weak_click_efficiency") },
    { id: "ctr", label: "CTR", metric: "ctr", value: current.ctr, previous: previous?.ctr ?? null, hint: "Clicks / impressions.", rate: true, findingId: null },
    { id: "conversions", label: "Conversion-linked clicks", metric: "conversions", value: current.conversions, previous: previous?.conversions ?? null, hint: "Clicks that received a future 30-day conversion label in this log snapshot. Not confirmed purchases or revenue.", findingId: related("cvr_anomaly") },
    { id: "cvr", label: "Conversion-link rate", metric: "cvr", value: current.cvr, previous: previous?.cvr ?? null, hint: "Share of clicks with a future 30-day conversion label in this window. Not live platform CVR or ROI.", rate: true, findingId: related("cvr_anomaly") || related("weak_click_efficiency") },
    { id: "attributed", label: "Attributed conversion links", metric: "attributed", value: current.attributed, previous: previous?.attributed ?? null, hint: "Conversions attributed to campaigns.", findingId: related("attribution_anomaly") },
    { id: "cost", label: "Cost index", metric: "cost", value: current.cost, previous: previous?.cost ?? null, hint: "Log cost index—not ad spend or budget.", cost: true, findingId: related("cost_rise") },
  ];
  return rows.map((row) => {
    const change = wow(row.value, row.previous);
    return {
      id: row.id,
      label: row.label,
      metric: row.metric,
      value: row.rate ? formatRate(row.value) : row.cost ? formatCost(row.value) : formatCount(row.value),
      delta: formatChange(change),
      deltaTone: deltaTone(row.metric, change),
      hint: row.hint,
      spark: trend.map((point) => point[row.metric]),
      findingId: row.findingId,
    };
  });
}

function toStats(campaign: CampaignSummary, current: Bucket, rows: CampaignDailyMetric[], window: WindowSpec): CampaignStats {
  const series = rows
    .filter((row) => row.day >= window.start && row.day <= window.end)
    .sort((a, b) => a.day - b.day);
  return {
    id: campaign.campaign_id,
    name: campaign.display_name,
    impressions: current.impressions,
    clicks: current.clicks,
    ctr: current.ctr,
    conversions: current.conversions,
    cvr: current.cvr,
    attributed: current.attributed,
    cost: current.cost,
    spark: series.map((row) => rate(row.conversions, row.clicks)),
  };
}

export function campaignSeries(campaignId: string, window: WindowSpec, daily = getDailyMetrics()): TrendPoint[] {
  const rows = daily.filter((row) => row.campaign_id === campaignId && row.day >= window.start && row.day <= window.end);
  return accountTrend(rows, window);
}

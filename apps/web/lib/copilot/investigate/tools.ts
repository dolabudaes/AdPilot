import { getCampaignById, getCampaigns, getDailyMetrics, getDatasetMeta } from "@/lib/analytics";
import type { CampaignDailyMetric } from "@/lib/analytics/types";
import { sumDaily } from "@/lib/copilot/diagnostics";
import { buildProductModel } from "@/lib/copilot/service";
import { resolveWindow } from "@/lib/copilot/windows";
import { formatChange, formatCost, formatCount, formatRate } from "@/lib/copilot/labels";
import { percentagePointChange, relativeChange } from "@/lib/copilot/metrics";
import { rate, wow } from "@/lib/workbench/format";
import type { TrendPoint } from "../types";
import { ACTION_LABEL, FINDING_LABEL, STATUS_LABEL } from "@/lib/copilot/labels";
import type {
  AnomalyResult,
  AttributionResult,
  Citation,
  CompareResult,
  DecisionHistoryResult,
  MetricValue,
  MetricsResult,
  ToolError,
  TrendResult,
} from "./types";

const SOURCE = "campaign_daily.csv";

export function getCampaignMetrics(campaignId: string, windowId: string): MetricsResult | ToolError {
  const opened = openCampaign(campaignId, windowId);
  if ("message" in opened) return { ok: false, tool: "get_campaign_metrics", message: opened.message || "Query failed" };
  const { campaign, window, meta, rows } = opened;
  const current = sumDaily(rows.filter((row) => row.day >= window.start && row.day <= window.end));
  const previous = window.compareStart != null && window.compareEnd != null
    ? sumDaily(rows.filter((row) => row.day >= window.compareStart! && row.day <= window.compareEnd!))
    : null;
  const metrics: MetricValue[] = [
    countMetric("impressions", "Impressions", current.impressions, previous?.impressions ?? null),
    countMetric("clicks", "Clicks", current.clicks, previous?.clicks ?? null),
    rateMetric("ctr", "CTR", current.ctr, previous?.ctr ?? null, current.impressions, previous?.impressions ?? null),
    countMetric("conversions", "Conversion-linked clicks", current.conversions, previous?.conversions ?? null),
    rateMetric("cvr", "Post-click conversion-link rate", current.cvr, previous?.cvr ?? null, current.clicks, previous?.clicks ?? null),
    countMetric("attributed", "Attributed conversion links", current.attributed, previous?.attributed ?? null),
    transformedIndexMetric("cost", "Cost index total", current.cost, previous?.cost ?? null),
    transformedIndexMetric("cost_per_click", "Average cost index per click", current.costPerClick, previous?.costPerClick ?? null),
  ];
  return {
    ok: true,
    tool: "get_campaign_metrics",
    campaignId: campaign.campaign_id,
    campaignName: campaign.display_name,
    windowId: window.id,
    windowLabel: window.label,
    compareLabel: window.compareLabel,
    snapshotAt: meta.generatedAt,
    source: SOURCE,
    metrics,
    citations: metrics.filter((item) => item.status === "ok").map((item) => cite(campaign.campaign_id, window.label, window.compareLabel, meta.generatedAt, item)),
  };
}

export function analyzeDailyTrend(campaignId: string, windowId: string, span: "both" | "current" | "all" = "both"): TrendResult | ToolError {
  const opened = openCampaign(campaignId, windowId);
  if ("message" in opened) return { ok: false, tool: "analyze_daily_trend", message: opened.message || "Query failed" };
  const { campaign, window, meta, rows } = opened;
  const start = span === "all" ? 1 : span === "current" ? window.start : window.compareStart ?? window.start;
  const end = span === "all" ? meta.maxDay : window.end;
  const points = pointsFor(rows, start, end);
  const summary = trendSummary(points, window.start, window.end);
  return {
    ok: true,
    tool: "analyze_daily_trend",
    campaignId: campaign.campaign_id,
    campaignName: campaign.display_name,
    windowLabel: window.label,
    compareLabel: window.compareLabel,
    snapshotAt: meta.generatedAt,
    source: SOURCE,
    points,
    currentStart: window.start,
    currentEnd: window.end,
    compareStart: window.compareStart,
    compareEnd: window.compareEnd,
    note: summary.note,
    citations: summary.citations.map((item) => ({
      ...item,
      source: `${SOURCE}${meta.generatedAt ? ` · Processed ${meta.generatedAt}` : ""}`,
      windowLabel: window.label,
      compareLabel: window.compareLabel,
      campaignId: campaign.campaign_id,
    })),
  };
}

export function compareCampaigns(campaignIds: string[], windowId: string): CompareResult | ToolError {
  const unique = [...new Set(campaignIds.map((item) => item.trim()).filter(Boolean))];
  if (unique.length < 2) return { ok: false, tool: "compare_campaigns", message: "At least two existing campaigns are required for comparison." };
  const meta = getDatasetMeta();
  const window = checkedWindow(windowId, meta.maxDay, meta.ready);
  if (typeof window === "string") return { ok: false, tool: "compare_campaigns", message: window };
  const model = buildProductModel({ accountId: "criteo-demo", windowId: window.id });
  const rows: CompareResult["rows"] = [];
  const citations: Citation[] = [];
  for (const id of unique) {
    const metrics = getCampaignMetrics(id, window.id);
    if (!metrics.ok) return { ok: false, tool: "compare_campaigns", message: metrics.message };
    const clicks = metrics.metrics.find((item) => item.key === "clicks");
    const conversions = metrics.metrics.find((item) => item.key === "conversions");
    const cvr = metrics.metrics.find((item) => item.key === "cvr");
    const ctr = metrics.metrics.find((item) => item.key === "ctr");
    const finding = model.findings.find((item) => item.campaignId === metrics.campaignId) || null;
    const signalMetric = cvr;
    rows.push({
      campaignId: metrics.campaignId,
      campaignName: metrics.campaignName,
      clicks: clicks?.current || 0,
      conversions: conversions?.current || 0,
      cvr: cvr?.status === "ok" ? cvr.current : null,
      ctr: ctr?.status === "ok" ? ctr.current : null,
      cvrRelativePct: cvr?.relativePct ?? null,
      cvrPointChange: cvr?.pointChange ?? null,
      clicksRelativePct: clicks?.relativePct ?? null,
      conversionsRelativePct: conversions?.relativePct ?? null,
      findingType: finding?.type || null,
      severity: finding?.severity || null,
      signalLabel: "Post-click conversion-link rate",
      signalMetric: "cvr",
      signalValue: formatRate(signalMetric?.current),
      signalRelativePct: signalMetric?.relativePct ?? null,
      signalTone: finding?.type === "scale_opportunity" ? "opportunity" : "risk",
    });
    for (const metric of ["clicks", "conversions", "cvr"]) {
      const citation = metrics.citations.find((item) => item.metric === metric);
      if (citation) citations.push(citation);
    }
  }
  return {
    ok: true,
    tool: "compare_campaigns",
    windowId: window.id,
    windowLabel: window.label,
    compareLabel: window.compareLabel,
    snapshotAt: meta.generatedAt,
    source: SOURCE,
    rows,
    citations,
  };
}

export function analyzeAttribution(campaignId: string, windowId: string): AttributionResult | ToolError {
  const opened = openCampaign(campaignId, windowId);
  if ("message" in opened) return { ok: false, tool: "analyze_attribution", message: opened.message || "Query failed" };
  const { campaign, window, meta, rows } = opened;
  const current = sumDaily(rows.filter((row) => row.day >= window.start && row.day <= window.end));
  const previous =
    window.compareStart != null && window.compareEnd != null
      ? sumDaily(rows.filter((row) => row.day >= window.compareStart! && row.day <= window.compareEnd!))
      : null;
  const share = current.conversions > 0 ? current.attributed / current.conversions : null;
  const prevShare = previous && previous.conversions > 0 ? previous.attributed / previous.conversions : null;
  const sharePointChange = share != null && prevShare != null ? (share - prevShare) * 100 : null;
  const note =
    share == null
      ? "This window has no conversion-linked clicks, so attribution-link share cannot be compared."
      : `Attributed conversion links are ${formatRate(share)} of conversion-linked clicks in this window. ${prevShare != null ? `The comparison window is ${formatRate(prevShare)}. ` : ""}This is a row-label share, not a unique conversion-event attribution rate.`;
  const citations: Citation[] = [
    {
      id: `attr:${campaign.campaign_id}:${window.label}:share`,
      label: "Attribution share",
      value: share == null ? "Unavailable" : formatRate(share),
      baseline: prevShare == null ? null : formatRate(prevShare),
      absolute: null,
      relative: sharePointChange == null ? null : `${sharePointChange > 0 ? "+" : ""}${sharePointChange.toFixed(2)} percentage points`,
      points: null,
      source: `${SOURCE} · ${meta.generatedAt || ""}`,
      windowLabel: window.label,
      compareLabel: window.compareLabel,
      campaignId: campaign.campaign_id,
      metric: "attribution_share",
    },
  ];
  return {
    ok: true,
    tool: "analyze_attribution",
    campaignId: campaign.campaign_id,
    campaignName: campaign.display_name,
    windowId: window.id,
    windowLabel: window.label,
    compareLabel: window.compareLabel,
    snapshotAt: meta.generatedAt,
    source: SOURCE,
    conversions: current.conversions,
    attributed: current.attributed,
    previousConversions: previous?.conversions ?? null,
    previousAttributed: previous?.attributed ?? null,
    attributionShare: share,
    previousAttributionShare: prevShare,
    sharePointChange,
    note,
    citations,
  };
}

export function detectAnomalousDays(campaignId: string, windowId: string): AnomalyResult | ToolError {
  const opened = openCampaign(campaignId, windowId);
  if ("message" in opened) return { ok: false, tool: "detect_anomalous_days", message: opened.message || "Query failed" };
  const { campaign, window, meta, rows } = opened;
  const points = pointsFor(rows, window.start, window.end);
  const usable = points.filter((point) => point.clicks >= 40 && point.cvr != null);
  const days: AnomalyResult["days"] = [];
  if (usable.length >= 4) {
    const mean = usable.reduce((sum, point) => sum + (point.cvr || 0), 0) / usable.length;
    const variance = usable.reduce((sum, point) => sum + ((point.cvr || 0) - mean) ** 2, 0) / usable.length;
    const sd = Math.sqrt(variance);
    for (const point of usable) {
      const z = sd >= 0.003 ? ((point.cvr || 0) - mean) / sd : null;
      const notable = z != null && z <= -1.6;
      days.push({
        day: point.day,
        metric: "cvr",
        z: z == null ? null : Number(z.toFixed(2)),
        fact: `D${point.day}: ${formatCount(point.clicks)} clicks, post-click conversion-link rate ${formatRate(point.cvr)}.`,
        notable,
      });
    }
  }
  const flagged = days.filter((item) => item.notable).sort((a, b) => (a.z || 0) - (b.z || 0)).slice(0, 4);
  const note =
    flagged.length === 0
      ? "No day in this window reached the deviation threshold. Normal variation is not labeled as an anomaly."
      : `${flagged.length} day(s) had a post-click conversion-link rate materially below the campaign-window mean. This is a statistical flag, not a root cause.`;
  return {
    ok: true,
    tool: "detect_anomalous_days",
    campaignId: campaign.campaign_id,
    campaignName: campaign.display_name,
    windowLabel: window.label,
    compareLabel: window.compareLabel,
    snapshotAt: meta.generatedAt,
    source: SOURCE,
    days: flagged.length ? flagged : days.slice(0, 7),
    note,
    citations: flagged.map((item) => ({
      id: `anomaly:${campaign.campaign_id}:d${item.day}`,
      label: `D${item.day} post-click conversion-link rate`,
      value: item.fact,
      baseline: null,
      absolute: item.z == null ? null : `z ${item.z}`,
      relative: null,
      points: null,
      source: SOURCE,
      windowLabel: window.label,
      compareLabel: window.compareLabel,
      campaignId: campaign.campaign_id,
      metric: "cvr",
    })),
  };
}

export function retrieveDecisionHistory(
  accountId: string,
  windowId: string,
  findingId: string | null,
  campaignId: string
): DecisionHistoryResult | ToolError {
  const model = buildProductModel({ accountId, windowId });
  const finding = findingId ? model.findings.find((item) => item.id === findingId) : model.findings.find((item) => item.campaignId === campaignId);
  if (!finding) return { ok: false, tool: "retrieve_decision_history", message: "No finding or decision record was found for this campaign in the current window." };
  const entries: DecisionHistoryResult["entries"] = [
    {
      kind: "finding",
      label: FINDING_LABEL[finding.type] || finding.type,
      detail: finding.interpretation,
      status: finding.severity,
      readOnly: true,
    },
  ];
  if (finding.recommendation) {
    const rec = finding.recommendation;
    entries.push({
      kind: "recommendation",
      label: ACTION_LABEL[rec.proposal.actionType],
      detail: rec.proposal.reason,
      status: STATUS_LABEL[rec.status] || rec.status,
      readOnly: true,
    });
    if (rec.decisionId) {
      entries.push({
        kind: "decision",
        label: "Human decision",
        detail: `Decision ID ${rec.decisionId}`,
        status: STATUS_LABEL[rec.status] || rec.status,
        readOnly: true,
      });
    }
  }
  return {
    ok: true,
    tool: "retrieve_decision_history",
    campaignId: finding.campaignId,
    campaignName: finding.campaignName,
    findingId: finding.id,
    windowLabel: finding.windowLabel,
    entries,
    note: "Read-only history. A conversation cannot change Exported or externally declared execution status.",
  };
}

function openCampaign(campaignId: string, windowId: string) {
  const meta = getDatasetMeta();
  const window = checkedWindow(windowId, meta.maxDay, meta.ready);
  if (typeof window === "string") return { message: window };
  const campaign = getCampaignById(campaignId) || getCampaigns().find((item) => item.display_name.toLowerCase() === campaignId.trim().toLowerCase());
  if (!campaign) return { message: `No campaign named ${campaignId}.` };
  const rows = getDailyMetrics().filter((row) => row.campaign_id === campaign.campaign_id);
  if (!rows.length) return { message: `${campaign.display_name} has no daily aggregates in the imported dataset.` };
  return { campaign, window, meta, rows };
}

function checkedWindow(windowId: string, maxDay: number, ready: boolean) {
  if (!ready) return "Processed dataset is not ready.";
  if (windowId !== "recent_7d" && !/^d\d+-d\d+$/.test(windowId)) return "Window must use processed relative day ranges.";
  const meta = getDatasetMeta();
  const window = resolveWindow(windowId, meta);
  const requested = /^d(\d+)-d(\d+)$/.exec(windowId);
  const matchesResolved = requested ? window?.start === Number(requested[1]) && window?.end === Number(requested[2]) : window?.id === windowId;
  if (!window || !matchesResolved) return `Window is outside the imported dataset (available D1–D${maxDay}).`;
  return window;
}

function countMetric(key: string, label: string, current: number, previous: number | null): MetricValue {
  return {
    key,
    label,
    current,
    previous,
    absolute: previous == null ? null : current - previous,
    relativePct: relativeChange(current, previous),
    pointChange: null,
    status: "ok",
    reason: null,
  };
}

function indexMetric(key: string, label: string, current: number | null, previous: number | null, denominator: number): MetricValue {
  if (current == null || denominator === 0) {
    return { key, label, current: null, previous, absolute: null, relativePct: null, pointChange: null, status: "unavailable", reason: "The denominator is zero or missing, so this metric cannot be calculated." };
  }
  return {
    key,
    label,
    current,
    previous,
    absolute: previous == null ? null : current - previous,
    relativePct: relativeChange(current, previous),
    pointChange: null,
    status: "ok",
    reason: null,
  };
}

function transformedIndexMetric(key: string, label: string, current: number | null, previous: number | null): MetricValue {
  if (current == null) {
    return { key, label, current: null, previous, absolute: null, relativePct: null, pointChange: null, status: "unavailable", reason: "The transformed cost index is missing." };
  }
  return {
    key,
    label,
    current,
    previous,
    absolute: previous == null ? null : current - previous,
    relativePct: null,
    pointChange: null,
    status: "ok",
    reason: "The source does not disclose a ratio-scale cost transform, so percentage improvement or deterioration is not reported.",
  };
}

export function rateMetric(key: string, label: string, current: number | null, previous: number | null, currentDenom: number, previousDenom: number | null): MetricValue {
  if (current == null || currentDenom === 0) {
    return { key, label, current: null, previous, absolute: null, relativePct: null, pointChange: null, status: "unavailable", reason: "The denominator is zero or missing, so this metric cannot be calculated." };
  }
  return {
    key,
    label,
    current,
    previous: previousDenom ? previous : null,
    absolute: null,
    relativePct: previousDenom ? relativeChange(current, previous) : null,
    pointChange: previousDenom ? percentagePointChange(current, previous) : null,
    status: "ok",
    reason: null,
  };
}

function cite(campaignId: string, windowLabel: string, compareLabel: string | null, snapshotAt: string | null, metric: MetricValue): Citation {
  const shown = present(metric);
  return {
    id: `metric:${campaignId}:${windowLabel}:${metric.key}`,
    label: metric.label,
    value: shown.value,
    baseline: shown.baseline,
    absolute: shown.absolute,
    relative: shown.relative,
    points: shown.points,
    source: `${SOURCE}${snapshotAt ? ` · Processed ${snapshotAt}` : ""}`,
    windowLabel,
    compareLabel,
    campaignId,
    metric: metric.key,
  };
}

function present(metric: MetricValue) {
  const rateKey = metric.key === "ctr" || metric.key === "cvr";
  const costKey = metric.key === "cost" || metric.key === "cost_per_click";
  const format = (value: number | null) => rateKey ? formatRate(value) : costKey ? formatCost(value) : formatCount(value);
  const absolute = metric.absolute == null ? null : `${metric.absolute > 0 ? "+" : metric.absolute < 0 ? "-" : ""}${costKey ? formatCost(Math.abs(metric.absolute)) : formatCount(Math.abs(metric.absolute))}`;
  const points = metric.pointChange == null ? null : `${metric.pointChange > 0 ? "+" : ""}${metric.pointChange.toFixed(2)} percentage points`;
  return {
    value: format(metric.current),
    baseline: metric.previous == null ? null : format(metric.previous),
    absolute,
    relative: metric.relativePct == null ? null : formatChange(metric.relativePct),
    points,
  };
}

function pointsFor(rows: CampaignDailyMetric[], start: number, end: number): TrendPoint[] {
  const days = new Map<number, CampaignDailyMetric[]>();
  for (const row of rows) {
    if (row.day < start || row.day > end) continue;
    const list = days.get(row.day) || [];
    list.push(row);
    days.set(row.day, list);
  }
  return [...days.entries()].sort((a, b) => a[0] - b[0]).map(([day, grouped]) => {
    const summed = sumDaily(grouped);
    return {
      day,
      impressions: summed.impressions,
      clicks: summed.clicks,
      conversions: summed.conversions,
      attributed: summed.attributed,
      cost: summed.cost,
      ctr: summed.ctr,
      cvr: rate(summed.conversions, summed.clicks),
    };
  });
}

function trendSummary(points: TrendPoint[], start: number, end: number) {
  const recent = points.filter((point) => point.day >= start && point.day <= end && point.clicks > 0);
  if (recent.length < 2) return { note: "This window has too few computable daily samples to determine whether the change persisted.", citations: [] as Citation[] };
  const prior = points.filter((point) => point.day < start && point.clicks > 0);
  const currentConversions = recent.reduce((sum, point) => sum + point.conversions, 0);
  const currentClicks = recent.reduce((sum, point) => sum + point.clicks, 0);
  const priorConversions = prior.reduce((sum, point) => sum + point.conversions, 0);
  const priorClicks = prior.reduce((sum, point) => sum + point.clicks, 0);
  const priorCvr = rate(priorConversions, priorClicks);
  const currentCvr = rate(currentConversions, currentClicks);
  const abovePrior = priorCvr == null ? null : recent.filter((point) => point.cvr != null && point.cvr > priorCvr).length;
  const topDay = [...recent].sort((a, b) => b.conversions - a.conversions)[0];
  const topDayShare = currentConversions > 0 ? topDay.conversions / currentConversions : null;
  const persistence = abovePrior == null
    ? "No prior-window aggregate is available for a daily persistence comparison."
    : `${abovePrior} of ${recent.length} days were above the prior-window aggregate post-click conversion-link rate of ${formatRate(priorCvr)}.`;
  const concentration = topDayShare == null
    ? "Daily conversion concentration is not computable."
    : `The top day, D${topDay.day}, accounted for ${(topDayShare * 100).toFixed(1)}% of current-window conversion-linked clicks.`;
  const shape = abovePrior != null && abovePrior >= Math.ceil(recent.length * 0.7)
    ? "The change was broad across the selected window rather than confined to one date."
    : "The aggregate change was uneven across the selected window, so daily variation remains material.";
  const note = `${persistence} ${concentration} ${shape} D labels are relative days, not calendar dates. These daily aggregates support a timing assessment, not a causal explanation.`;
  const citations: Citation[] = [
    {
      id: `trend:persistence:d${start}-d${end}`,
      label: "Days above prior-window aggregate conversion-link rate",
      value: abovePrior == null ? "Unavailable" : `${abovePrior} of ${recent.length} days`,
      baseline: priorCvr == null ? null : formatRate(priorCvr),
      absolute: null,
      relative: currentCvr == null || priorCvr == null ? null : formatChange(wow(currentCvr, priorCvr)),
      points: null,
      source: SOURCE,
      windowLabel: `D${start}–D${end}`,
      compareLabel: null,
      campaignId: "",
      metric: "daily_cvr_persistence",
    },
    {
      id: `trend:concentration:d${start}-d${end}`,
      label: "Top-day conversion-linked-click share",
      value: topDayShare == null ? "Unavailable" : `${(topDayShare * 100).toFixed(1)}%`,
      baseline: null,
      absolute: `D${topDay.day}`,
      relative: null,
      points: null,
      source: SOURCE,
      windowLabel: `D${start}–D${end}`,
      compareLabel: null,
      campaignId: "",
      metric: "daily_conversion_concentration",
    },
  ];
  return { note, citations };
}

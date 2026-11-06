import fs from "node:fs";
import path from "node:path";
import {
  CampaignDailyMetric,
  CampaignFact,
  CampaignMetric,
  CampaignSummary,
  Insight,
} from "./types";
import { RawCriteoRow } from "../types";
import { ensureDemoIfEmpty } from "../seed";
import { getDb } from "../db";
import { resolveDataDir } from "../paths";

const DEFAULT_MAX_CAMPAIGNS = 50;
const PROCESSED_DIR = path.join(resolveDataDir(), "processed");
const SUMMARY_PATH = path.join(PROCESSED_DIR, "campaign_summary.json");
const DAILY_PATH = path.join(PROCESSED_DIR, "campaign_daily.csv");
const FACTS_PATH = path.join(PROCESSED_DIR, "campaign_facts.json");

export interface AnalyticsContext {
  metrics: CampaignMetric[];
  total: {
    impressions: number;
    clicks: number;
    conversions: number;
    attributedConversions: number;
    cost: number;
  };
}

type SummaryFile = {
  campaigns?: CampaignSummary[];
};

type FactsFile = {
  campaigns?: CampaignFact[];
};

function asNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read processed data file ${filePath}. Run npm run data:prepare first. Detail: ${detail}`);
  }
}

function processedReady() {
  return fs.existsSync(SUMMARY_PATH) && fs.existsSync(DAILY_PATH) && fs.existsSync(FACTS_PATH);
}

function parseCsv(filePath: string): Record<string, string>[] {
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((key, index) => {
      row[key] = values[index] ?? "";
    });
    return row;
  });
}

function toDailyMetric(row: Record<string, string>): CampaignDailyMetric {
  return {
    day: asNumber(row.day),
    campaign_id: row.campaign_id,
    display_name: row.display_name,
    raw_campaign_id: row.raw_campaign_id,
    impressions: asNumber(row.impressions),
    clicks: asNumber(row.clicks),
    conversions: asNumber(row.conversions),
    attributed_conversions: asNumber(row.attributed_conversions),
    total_cost: asNumber(row.total_cost),
    ctr: asNumber(row.ctr),
    conversion_rate: asNumber(row.conversion_rate),
    attributed_conversion_rate: asNumber(row.attributed_conversion_rate),
    click_to_conversion_rate: asNumber(row.click_to_conversion_rate),
    attribution_share: asNumber(row.attribution_share),
    cost_efficiency: asNumber(row.cost_efficiency),
  };
}

export function getCampaigns(): CampaignSummary[] {
  if (!processedReady()) return [];
  const summary = readJsonFile<SummaryFile>(SUMMARY_PATH);
  return [...(summary.campaigns || [])].sort((a, b) => b.impressions - a.impressions);
}

export function getCampaignById(campaignId: string): CampaignSummary | null {
  const id = String(campaignId);
  return getCampaigns().find((campaign) => campaign.campaign_id === id || campaign.raw_campaign_id === id) || null;
}

export function getCampaignFacts(campaignId?: string): CampaignFact[] {
  if (!processedReady()) return [];
  const facts = readJsonFile<FactsFile>(FACTS_PATH).campaigns || [];
  if (!campaignId) return facts;
  return facts.filter((fact) => fact.campaign_id === campaignId || fact.raw_campaign_id === campaignId);
}

export function getCampaignTrend(campaignId: string): CampaignDailyMetric[] {
  if (!processedReady()) return [];
  const campaign = getCampaignById(campaignId);
  if (!campaign) return [];
  return parseCsv(DAILY_PATH)
    .map(toDailyMetric)
    .filter((row) => row.campaign_id === campaign.campaign_id || row.raw_campaign_id === campaign.raw_campaign_id)
    .sort((a, b) => a.day - b.day);
}

export function compareCampaigns(metric: keyof CampaignSummary = "attributed_conversion_rate", limit = 3) {
  const campaigns = getCampaigns().filter((campaign) => Number.isFinite(asNumber(campaign[metric])));
  const sorted = [...campaigns].sort((a, b) => asNumber(b[metric]) - asNumber(a[metric]));
  return {
    top: sorted.slice(0, limit),
    bottom: sorted.slice(-limit).reverse(),
    metric,
  };
}

export function getTopConversionCampaigns(limit = 5) {
  return [...getCampaigns()]
    .filter((campaign) => campaign.conversions > 0)
    .sort((a, b) => {
      const byRate = b.conversion_rate - a.conversion_rate;
      return byRate !== 0 ? byRate : b.conversions - a.conversions;
    })
    .slice(0, limit);
}

export function getLowEfficiencyCampaigns(limit = 5) {
  return [...getCampaigns()]
    .filter((campaign) => campaign.clicks > 0)
    .sort((a, b) => {
      const aPenalty = a.attributed_conversion_rate + a.click_to_conversion_rate;
      const bPenalty = b.attributed_conversion_rate + b.click_to_conversion_rate;
      return aPenalty - bPenalty || b.clicks - a.clicks;
    })
    .slice(0, limit);
}

export function getRecentDecliningCampaigns(limit = 5) {
  return [...getCampaigns()]
    .filter((campaign) => {
      const conversionRateChange = campaign.changes.conversion_rate_change_pct;
      const attributedRateChange = campaign.changes.attributed_conversion_rate_change_pct;
      return (conversionRateChange ?? 0) < 0 || (attributedRateChange ?? 0) < 0;
    })
    .sort((a, b) => {
      const aDecline = Math.min(
        asNumber(a.changes.conversion_rate_change_pct, 0),
        asNumber(a.changes.attributed_conversion_rate_change_pct, 0)
      );
      const bDecline = Math.min(
        asNumber(b.changes.conversion_rate_change_pct, 0),
        asNumber(b.changes.attributed_conversion_rate_change_pct, 0)
      );
      return aDecline - bDecline;
    })
    .slice(0, limit);
}

export function getTopCampaignFacts(limit = 5) {
  return getCampaignFacts()
    .flatMap((campaign) =>
      campaign.facts.map((fact) => ({
        campaign_id: campaign.campaign_id,
        display_name: campaign.display_name,
        raw_campaign_id: campaign.raw_campaign_id,
        ...fact,
      }))
    )
    .slice(0, limit);
}

function summaryToMetric(campaign: CampaignSummary): CampaignMetric {
  return {
    campaignId: campaign.campaign_id,
    displayName: campaign.display_name,
    rawCampaignId: campaign.raw_campaign_id,
    impressions: campaign.impressions,
    clicks: campaign.clicks,
    conversions: campaign.conversions,
    attributedConversions: campaign.attributed_conversions,
    cost: campaign.total_cost,
    ctr: campaign.ctr,
    conversionRate: campaign.conversion_rate,
    attributedConversionRate: campaign.attributed_conversion_rate,
    clickToConversionRate: campaign.click_to_conversion_rate,
    costEfficiency: campaign.cost_efficiency,
  };
}

function getTotalMetrics(metrics: CampaignMetric[]) {
  return metrics.reduce(
    (acc, metric) => {
      acc.impressions += metric.impressions;
      acc.clicks += metric.clicks;
      acc.conversions += metric.conversions;
      acc.attributedConversions += metric.attributedConversions;
      acc.cost += metric.cost;
      return acc;
    },
    { impressions: 0, clicks: 0, conversions: 0, attributedConversions: 0, cost: 0 }
  );
}

export function loadDataset(limitCampaigns = DEFAULT_MAX_CAMPAIGNS): AnalyticsContext {
  const processedCampaigns = getCampaigns();
  if (processedCampaigns.length) {
    const metrics = processedCampaigns.slice(0, limitCampaigns).map(summaryToMetric);
    return { metrics, total: getTotalMetrics(metrics) };
  }

  ensureDemoIfEmpty();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT campaign_id, impressions, clicks, conversions, attributed_conversions, cost, ctr, conversion_rate, attributed_conversion_rate, cost_efficiency
       FROM campaign_metrics
       ORDER BY impressions DESC
       LIMIT ?`
    )
    .all(limitCampaigns) as Array<{
    campaign_id: string;
    impressions: number;
    clicks: number;
    conversions: number;
    attributed_conversions: number;
    cost: number;
    ctr: number;
    conversion_rate: number;
    attributed_conversion_rate: number;
    cost_efficiency: number;
  }>;

  const metrics: CampaignMetric[] = rows.map((row) => ({
    campaignId: row.campaign_id,
    impressions: row.impressions,
    clicks: row.clicks,
    conversions: row.conversions,
    attributedConversions: row.attributed_conversions,
    cost: row.cost,
    ctr: row.ctr,
    conversionRate: row.conversion_rate,
    attributedConversionRate: row.attributed_conversion_rate,
    clickToConversionRate: row.clicks > 0 ? row.conversions / row.clicks : 0,
    costEfficiency: row.cost_efficiency,
  }));

  return { metrics, total: getTotalMetrics(metrics) };
}

export function getCampaignPerformance(campaignId: string): CampaignMetric | null {
  const campaign = getCampaignById(campaignId);
  if (campaign) return summaryToMetric(campaign);

  const db = getDb();
  const row = db
    .prepare(
      `SELECT campaign_id, impressions, clicks, conversions, attributed_conversions, cost, ctr, conversion_rate, attributed_conversion_rate, cost_efficiency
       FROM campaign_metrics WHERE campaign_id = ?`
    )
    .get(campaignId) as null | {
      campaign_id: string;
      impressions: number;
      clicks: number;
      conversions: number;
      attributed_conversions: number;
      cost: number;
      ctr: number;
      conversion_rate: number;
      attributed_conversion_rate: number;
      cost_efficiency: number;
    };

  if (!row) return null;
  return {
    campaignId: row.campaign_id,
    impressions: row.impressions,
    clicks: row.clicks,
    conversions: row.conversions,
    attributedConversions: row.attributed_conversions,
    cost: row.cost,
    ctr: row.ctr,
    conversionRate: row.conversion_rate,
    attributedConversionRate: row.attributed_conversion_rate,
    clickToConversionRate: row.clicks > 0 ? row.conversions / row.clicks : 0,
    costEfficiency: row.cost_efficiency,
  };
}

export function getConversionAnalysis() {
  return {
    highestConversionCampaigns: getTopConversionCampaigns(3).map(summaryToMetric),
    lowestConversionCampaigns: [...getCampaigns()].sort((a, b) => a.conversion_rate - b.conversion_rate).slice(0, 3).map(summaryToMetric),
  };
}

export function getAttributionAnalysis() {
  const ranked = compareCampaigns("attributed_conversion_rate", 3);
  return {
    bestAttributedCampaigns: ranked.top.map(summaryToMetric),
    worstAttributedCampaigns: ranked.bottom.map(summaryToMetric),
  };
}

export function getCostAnalysis() {
  const ranked = compareCampaigns("cost_efficiency", 3);
  return {
    highestROI: ranked.top.map(summaryToMetric),
    lowestROI: ranked.bottom.map(summaryToMetric),
  };
}

export function getTrendAnalysis() {
  return getRecentDecliningCampaigns(5).map((campaign) => ({
    campaignId: campaign.campaign_id,
    conversionRateChangePct: campaign.changes.conversion_rate_change_pct,
    attributedConversionRateChangePct: campaign.changes.attributed_conversion_rate_change_pct,
  }));
}

export function findCandidateInsights(goal: string, limit = 3): Insight[] {
  const campaigns =
    goal.includes("click") || goal.includes("traffic") || goal.includes("流量")
      ? compareCampaigns("ctr", limit).top
      : goal.includes("risk") || goal.includes("风险") || goal.includes("下降")
        ? getRecentDecliningCampaigns(limit)
        : getLowEfficiencyCampaigns(limit);

  return campaigns.slice(0, limit).map((campaign) => {
    const facts = getCampaignFacts(campaign.campaign_id)[0]?.facts || [];
    const firstFact = facts[0]?.text;
    return {
      id: `insight-${campaign.campaign_id}`,
      campaignId: campaign.campaign_id,
      type: firstFact ? facts[0].type : "metric_gap",
      title: `${campaign.campaign_id} shows notable metric movement`,
      description:
        firstFact ||
        `CTR ${(campaign.ctr * 100).toFixed(2)}%, conversion rate ${(campaign.conversion_rate * 100).toFixed(2)}%, attributed conversion rate ${(campaign.attributed_conversion_rate * 100).toFixed(2)}%.`,
      evidence: "Source: processed campaign aggregates and campaign_facts.json.",
      relevanceToGoal: "High",
      confidence: 0.82,
    };
  });
}

export function aggregateCampaigns(rows: RawCriteoRow[], limitCampaigns = DEFAULT_MAX_CAMPAIGNS): CampaignMetric[] {
  const map = new Map<string, {
    impressions: number;
    clicks: number;
    conversions: number;
    attributedConversions: number;
    cost: number;
  }>();

  for (const row of rows.slice(0, 50000)) {
    const campaignId = row.campaign;
    if (!map.has(campaignId)) {
      map.set(campaignId, {
        impressions: 0,
        clicks: 0,
        conversions: 0,
        attributedConversions: 0,
        cost: 0,
      });
    }
    const state = map.get(campaignId)!;
    state.impressions += 1;
    state.clicks += Number(row.click) || 0;
    state.conversions += Number(row.conversion) || 0;
    state.attributedConversions += Number(row.attribution) || 0;
    state.cost += Number(row.cost) || 0;
  }

  return [...map.entries()]
    .slice(0, limitCampaigns)
    .map(([campaignId, totals]) => calculateMetrics(campaignId, totals))
    .sort((a, b) => b.impressions - a.impressions);
}

export function calculateMetrics(
  campaignId: string,
  totals: { impressions: number; clicks: number; conversions: number; attributedConversions: number; cost: number }
): CampaignMetric {
  const impressions = totals.impressions || 0;
  const clicks = totals.clicks || 0;
  const conversions = totals.conversions || 0;
  const attributedConversions = totals.attributedConversions || 0;
  const cost = totals.cost || 0;

  return {
    campaignId,
    impressions,
    clicks,
    conversions,
    attributedConversions,
    cost,
    ctr: impressions > 0 ? clicks / impressions : 0,
    conversionRate: impressions > 0 ? conversions / impressions : 0,
    attributedConversionRate: impressions > 0 ? attributedConversions / impressions : 0,
    clickToConversionRate: clicks > 0 ? conversions / clicks : 0,
    costEfficiency: cost > 0 ? attributedConversions / cost : 0,
  };
}

export type DatasetMeta = {
  ready: boolean;
  schemaVersion: number | null;
  generatedAt: string | null;
  datasetVersion: string | null;
  sourceSha256: string | null;
  maxDay: number;
  recentStart: number;
  recentEnd: number;
  previousStart: number;
  previousEnd: number;
  sourceName: string | null;
  rowCount: number | null;
  conversionMarkerRows: number | null;
  uniqueConversionEvents: number | null;
  uniqueAttributedConversionEvents: number | null;
  conversionWithoutClickRows: number | null;
  fieldMapping: Record<string, string>;
};

const EMPTY_META: DatasetMeta = {
  ready: false,
  schemaVersion: null,
  generatedAt: null,
  datasetVersion: null,
  sourceSha256: null,
  maxDay: 0,
  recentStart: 0,
  recentEnd: 0,
  previousStart: 0,
  previousEnd: 0,
  sourceName: null,
  rowCount: null,
  conversionMarkerRows: null,
  uniqueConversionEvents: null,
  uniqueAttributedConversionEvents: null,
  conversionWithoutClickRows: null,
  fieldMapping: {},
};

export function getDatasetMeta(): DatasetMeta {
  if (!processedReady()) return EMPTY_META;
  try {
    const summary = readJsonFile<{
      schema_version?: number;
      generated_at?: string;
      window?: {
        max_day?: number;
        recent_7d?: { start_day?: number; end_day?: number };
        previous_7d?: { start_day?: number; end_day?: number };
      };
      source?: { file_path?: string; row_count?: number; field_mapping?: Record<string, string>; sha256?: string };
      audit?: {
        conversion_marker_rows?: number;
        unique_conversion_events?: number;
        unique_attributed_conversion_events?: number;
        conversion_without_click_rows?: number;
      };
    }>(SUMMARY_PATH);
    const schemaVersion = summary.schema_version || 1;
    const sourceSha256 = summary.source?.sha256 || null;
    return {
      ready: true,
      schemaVersion,
      generatedAt: summary.generated_at || null,
      datasetVersion: sourceSha256 ? `schema-${schemaVersion}:${sourceSha256}` : summary.generated_at || null,
      sourceSha256,
      maxDay: summary.window?.max_day || 31,
      recentStart: summary.window?.recent_7d?.start_day || 25,
      recentEnd: summary.window?.recent_7d?.end_day || 31,
      previousStart: summary.window?.previous_7d?.start_day || 18,
      previousEnd: summary.window?.previous_7d?.end_day || 24,
      sourceName: summary.source?.file_path?.split("/").pop() || null,
      rowCount: summary.source?.row_count ?? null,
      conversionMarkerRows: summary.audit?.conversion_marker_rows ?? null,
      uniqueConversionEvents: summary.audit?.unique_conversion_events ?? null,
      uniqueAttributedConversionEvents: summary.audit?.unique_attributed_conversion_events ?? null,
      conversionWithoutClickRows: summary.audit?.conversion_without_click_rows ?? null,
      fieldMapping: summary.source?.field_mapping || {},
    };
  } catch {
    return EMPTY_META;
  }
}

export function getDailyMetrics(): CampaignDailyMetric[] {
  if (!processedReady()) return [];
  return parseCsv(DAILY_PATH).map(toDailyMetric);
}

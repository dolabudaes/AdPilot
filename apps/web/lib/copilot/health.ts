import { getCampaigns, getDatasetMeta, getDailyMetrics } from "@/lib/analytics";
import { getSettings, listAnalysisRuns, listDataSources } from "@/lib/dataStore";
import { countPendingDecisions } from "./store";

export type DataHealth = {
  serviceOnline: boolean;
  sourceConnected: boolean;
  filesReady: boolean;
  generatedAt: string | null;
  ageDays: number | null;
  stale: boolean;
  staleAfterDays: number;
  campaignCount: number;
  dayCount: number;
  dayMin: number | null;
  dayMax: number | null;
  diagnosableShare: number | null;
  fieldMapping: Array<{ source: string; target: string }>;
  unavailable: Array<{ field: string; reason: string }>;
  affected: string[];
  runs: Array<{ id: string; type: string; status: string; startedAt: string; error: string | null; summary: string }>;
  lastUploadAt: string | null;
  lastUploadName: string | null;
};

export function ageDays(value: string | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86400000));
}

export function getDataHealth(): DataHealth {
  const settings = getSettings();
  const sources = listDataSources();
  const source = sources.find((item) => item.id === "criteo-demo") || sources[0];
  const meta = getDatasetMeta();
  const daily = meta.ready ? getDailyMetrics() : [];
  const campaigns = meta.ready ? getCampaigns() : [];
  const days = [...new Set(daily.map((row) => row.day))].sort((a, b) => a - b);
  const age = ageDays(meta.generatedAt);
  const stale = age != null && age > settings.stale_after_days;
  const minClicks = settings.analysis_min_clicks || 80;
  const recent = campaigns.filter((campaign) => campaign.recent_7d.clicks >= minClicks && campaign.previous_7d.clicks >= minClicks);
  const metadata = (source?.metadata || {}) as { lastFileName?: string };
  const affected = ["Budget, bid, and ROAS proposals are not generated because source data lacks those fields."];
  if (!meta.ready) affected.unshift("Campaign diagnostics are unavailable because processed data files are missing.");
  if (stale) affected.unshift(`Diagnostics describe a snapshot from ${age} days ago, not today's account.`);
  if (!daily.some((row) => row.total_cost > 0)) affected.push("Cost index diagnostics are unavailable.");

  return {
    serviceOnline: true,
    sourceConnected: source?.status === "connected",
    filesReady: meta.ready && campaigns.length > 0 && daily.length > 0,
    generatedAt: meta.generatedAt,
    ageDays: age,
    stale,
    staleAfterDays: settings.stale_after_days,
    campaignCount: campaigns.length,
    dayCount: days.length,
    dayMin: days[0] ?? null,
    dayMax: days[days.length - 1] ?? null,
    diagnosableShare: campaigns.length ? recent.length / campaigns.length : null,
    fieldMapping: Object.entries(meta.fieldMapping).map(([target, sourceName]) => ({ source: String(sourceName), target })),
    unavailable: [
      { field: "Budget", reason: "Logs do not include a budget field." },
      { field: "Bid", reason: "Logs do not include a bid field." },
      { field: "ROAS / CPA", reason: "Without revenue or target cost, these cannot be calculated." },
      { field: "Ad spend", reason: "total_cost is a cost index only—not spend amount." },
    ],
    affected,
    runs: listAnalysisRuns(12).map((run) => ({
      id: run.id,
      type: run.runType,
      status: run.status,
      startedAt: run.startedAt,
      error: run.error,
      summary: String(run.output?.kind || run.output?.campaignCount || run.input?.query || run.runType),
    })),
    lastUploadAt: source?.lastSyncedAt || null,
    lastUploadName: metadata.lastFileName || null,
  };
}

export function pendingReviewCount() {
  try {
    return countPendingDecisions();
  } catch {
    return 0;
  }
}

import type { ActionType } from "@/lib/analytics/types";
import { getDatasetMeta } from "@/lib/analytics";
import { completeAnalysisRun, createAnalysisRun, failAnalysisRun, getSettings, listAnalysisRuns, listDataSources, setAnalysisProgress } from "@/lib/dataStore";
import { ageDays } from "./health";
import { campaignSeries, DEMO_ACCOUNT_ID, diagnose, loadAnalysisInputs } from "./diagnostics";
import { propose } from "./recommend";
import { proposalConsistencyIssue } from "./proposal-consistency";
import {
  confirmRecommendation,
  CopilotError,
  dismissRecommendation,
  ensureDraftDecision,
  exportDecision,
  getDecision,
  listDecisions,
  listStoredRecommendations,
  overlayRecommendation,
  recommendationIdFor,
  saveRecommendationEdit,
  snapshotFindings,
  getStoredRecommendation,
} from "./store";
import type { FindingDraft, FindingView, ProductModel, Severity } from "./types";
import { resolveWindow, windowOptions } from "./windows";

const STEPS = [
  { id: "read", label: "Account data loaded", state: "done" as const },
  { id: "check", label: "Metric changes checked", state: "done" as const },
  { id: "locate", label: "Threshold campaigns located", state: "done" as const },
  { id: "advise", label: "Review-ready proposals formed", state: "done" as const },
];

export function buildProductModel(input: { accountId?: string | null; windowId?: string | null } = {}): ProductModel {
  const checkedAt = new Date().toISOString();
  const accountId = input.accountId || DEMO_ACCOUNT_ID;
  const sources = safeSources();
  const account = {
    id: accountId,
    name: accountId === DEMO_ACCOUNT_ID ? "Criteo log snapshot" : sources.find((item) => item.id === accountId)?.name || "Demo ad account",
    demo: accountId === DEMO_ACCOUNT_ID,
  };
  const meta = safeMeta();
  const settings = safeSettings();
  const base = emptyModel(account, checkedAt, windowOptions(meta));

  if (accountId !== DEMO_ACCOUNT_ID) {
    return { ...base, emptyReason: "unknown_account", briefing: { ...base.briefing, headline: "This account has no analyzable data yet", summary: "Only the demo processed logs can generate diagnostics. Unconnected platforms are not shown as connected." } };
  }
  if (!meta.ready) {
    const connected = sources.some((item) => item.status === "connected");
    return {
      ...base,
      emptyReason: connected ? "not_synced" : "no_source",
      briefing: {
        ...base.briefing,
        headline: connected ? "Data source registered, but no analyzable files yet" : "No connected data to analyze",
        summary: connected ? "Confirm summary files under data/processed have been generated." : "Connect data before diagnostics can run.",
      },
    };
  }

  const window = resolveWindow(input.windowId, meta);
  if (!window) return { ...base, emptyReason: "incomplete" };
  const { campaigns, daily } = loadAnalysisInputs();
  if (!campaigns.length || !daily.length) {
    return { ...base, emptyReason: "incomplete", window: publicWindow(window), generatedAt: meta.generatedAt };
  }

  const diagnosis = diagnose({
    accountId,
    window,
    campaigns,
    daily,
    minClicks: settings.analysis_min_clicks,
    meta,
  });
  const stored = listStoredRecommendations(accountId, window.id);
  const storedByFinding = new Map(stored.filter((item) => item.datasetVersion === meta.datasetVersion).map((item) => [item.findingId, item]));
  const findings: FindingView[] = diagnosis.findings.map((draft) => {
    const live = propose(draft);
    const saved = storedByFinding.get(draft.id);
    const recommendation = overlayRecommendation(draft, saved, live);
    return { ...draft, recommendation, stale: false };
  });

  for (const saved of stored) {
    if (findings.some((item) => item.id === saved.findingId)) continue;
    if (saved.status === "draft" && !saved.userEdited) continue;
    if (!saved.findingSnapshot) continue;
    findings.push({
      ...saved.findingSnapshot,
      recommendation: saved,
      stale: true,
      summary: `${saved.findingSnapshot.summary} The latest check no longer matches this rule; the saved proposal is kept.`,
    });
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const byCampaign = new Map<string, FindingView>();
  for (const finding of findings) {
    const current = byCampaign.get(finding.campaignId);
    if (!current || rank[finding.severity] < rank[current.severity]) byCampaign.set(finding.campaignId, finding);
  }
  const openRecommendationCount = findings.filter((item) => item.recommendation && item.recommendation.status === "draft").length;
  const problems = findings.filter((item) => item.severity === "high" || item.severity === "medium");
  const age = ageDays(meta.generatedAt);
  const stale = age != null && age > settings.stale_after_days;
  const cvr = diagnosis.kpis.find((item) => item.id === "cvr");
  const conversions = diagnosis.kpis.find((item) => item.id === "conversions");
  const names = problems.slice(0, 3).map((item) => item.campaignName);
  const headline = !window.compareLabel
    ? "Full range has no comparison window; change-based anomalies were skipped"
    : problems.length
      ? `${window.label}: ${problems.length} issue${problems.length === 1 ? "" : "s"} crossed thresholds`
      : "No issues crossed thresholds in this window";
  const noComp = "No comparison";
  const summary = problems.length
    ? `${names.join(", ")} deserve priority review. Post-click conversion-link rate change ${cvr?.delta || noComp}; conversion-linked clicks change ${conversions?.delta || noComp}. Proposals need human approval; approval does not write to ad platforms.`
    : `Post-click conversion-link rate change ${cvr?.delta || noComp}; conversion-linked clicks change ${conversions?.delta || noComp}. Sub-threshold moves stay on the watchlist—not optimization actions.`;

  return {
    ready: true,
    demo: true,
    stale,
    ageDays: age,
    emptyReason: null,
    account,
    window: publicWindow(window),
    windowOptions: windowOptions(meta),
    generatedAt: meta.generatedAt,
    checkedAt,
    savedRunAt: latestSavedRun(),
    sourceLabel: "campaign_daily.csv / campaign_summary.json",
    missing: diagnosis.missing,
    briefing: { headline, summary: stale ? `${summary} Data is a ${age}-day-old snapshot.` : summary, problemNames: names, findingCount: problems.length, openRecommendationCount },
    steps: window.compareLabel ? STEPS : STEPS.map((step) => (step.id === "locate" ? { ...step, label: "No comparison window—change anomalies skipped" } : step)),
    kpis: diagnosis.kpis,
    trend: diagnosis.trend,
    anomalies: diagnosis.anomalies,
    watchlist: diagnosis.watchlist,
    findings,
    campaigns: diagnosis.campaigns.map((campaign) => {
      const finding = byCampaign.get(campaign.id) || null;
      return {
        ...campaign,
        findingId: finding?.id || null,
        anomaly: finding && finding.severity !== "info" ? finding.title : null,
        findingType: finding && finding.severity !== "info" ? finding.type : null,
        severity: finding?.severity || null,
        recommendationStatus: finding?.recommendation?.status || null,
        recommendationCount: finding?.recommendation ? 1 : 0,
      };
    }),
  };
}

export function getCampaignDetail(campaignId: string, windowId?: string | null) {
  const model = buildProductModel({ windowId, accountId: DEMO_ACCOUNT_ID });
  const row = model.campaigns.find((item) => item.id === campaignId);
  const meta = getDatasetMeta();
  const window = resolveWindow(windowId, meta);
  if (!row || !window) return null;
  return {
    row,
    series: campaignSeries(campaignId, window),
    findings: model.findings.filter((item) => item.campaignId === campaignId),
    unavailable: [
      { field: "Budget", reason: "The current data source has no budget field." },
      { field: "Bid", reason: "The current data source has no bid field." },
      { field: "ROAS", reason: "Revenue data is unavailable, so ROAS cannot be calculated." },
      { field: "Ad spend", reason: "Cost index must not be treated as spend amount." },
    ],
    window: model.window,
    demo: model.demo,
    stale: model.stale,
    generatedAt: model.generatedAt,
  };
}

export function saveCheckRun(input: { accountId?: string | null; windowId?: string | null }) {
  const runId = createAnalysisRun({ runType: "strategy_analysis", input: { kind: "copilot_refresh", windowId: input.windowId || "recent_7d" } });
  try {
    const model = buildProductModel(input);
    const drafts: FindingDraft[] = model.findings.map(asDraft);
    snapshotFindings(drafts);
    setAnalysisProgress(runId, model.steps);
    completeAnalysisRun(runId, {
      output: { kind: "copilot_refresh", findingCount: model.briefing.findingCount, windowId: model.window?.id || null, headline: model.briefing.headline },
    });
    return { runId, model: { ...model, savedRunAt: new Date().toISOString() } };
  } catch (error) {
    failAnalysisRun(runId, error instanceof Error ? error.message : "Check failed");
    throw error;
  }
}

export function ensureFindingDraft(findingId: string, actorId: string, conversationId?: string | null) {
  const finding = requireLiveFinding(findingId);
  if (!finding.recommendation) throw new CopilotError("This issue has no proposal to save.", 404);
  return ensureDraftDecision({
    finding: asDraft(finding),
    original: finding.recommendation.original,
    proposal: finding.recommendation.proposal,
    actorId,
    conversationId,
    userEdited: finding.recommendation.userEdited,
  });
}

export function createRecommendation(findingId: string, actorId: string) {
  const finding = requireLiveFinding(findingId);
  if (!finding.recommendation) throw new CopilotError("This issue has no proposal to save.", 404);
  const existing = getStoredRecommendation(recommendationIdFor(findingId));
  if (existing && existing.status !== "draft") return existing;
  return saveRecommendationEdit({
    finding: asDraft(finding),
    original: finding.recommendation.original,
    proposal: finding.recommendation.proposal,
    actorId,
    userEdited: finding.recommendation.userEdited,
  });
}

export function editFinding(findingId: string, actorId: string, actionType: ActionType, reason: string) {
  const finding = requireLiveFinding(findingId);
  const draft = asDraft(finding);
  const proposal = propose(draft, { actionType, reason });
  if (!proposal) throw new CopilotError("This issue has no proposal to edit.");
  const original = finding.recommendation?.original || propose(draft) || proposal;
  return saveRecommendationEdit({ finding: draft, original, proposal, actorId });
}

export function confirmFinding(findingId: string, actorId: string) {
  const finding = requireLiveFinding(findingId);
  if (!finding.recommendation) throw new CopilotError("No recommendation is ready to confirm.", 404);
  const consistencyIssue = proposalConsistencyIssue(finding.recommendation.proposal.actionType, finding.recommendation.proposal.reason);
  if (consistencyIssue) throw new CopilotError(consistencyIssue);
  return confirmRecommendation({
    finding: asDraft(finding),
    proposal: finding.recommendation.proposal,
    original: finding.recommendation.original,
    actorId,
  });
}

export function dismissFinding(findingId: string, actorId: string) {
  const finding = requireLiveFinding(findingId);
  if (!finding.recommendation) throw new CopilotError("No recommendation is available to dismiss.", 404);
  const id = recommendationIdFor(findingId);
  if (!getStoredRecommendation(id)) {
    saveRecommendationEdit({
      finding: asDraft(finding),
      original: finding.recommendation.original,
      proposal: finding.recommendation.proposal,
      actorId,
      userEdited: finding.recommendation.userEdited,
    });
  }
  return dismissRecommendation(id, actorId);
}

export { exportDecision, getDecision, listDecisions, CopilotError };

function requireLiveFinding(findingId: string) {
  const parsed = parseFindingId(findingId);
  if (!parsed) throw new CopilotError("Unrecognized finding id.");
  const model = buildProductModel({ accountId: parsed.accountId, windowId: parsed.windowId });
  const finding = model.findings.find((item) => item.id === findingId);
  if (!finding) throw new CopilotError("Finding not found.", 404);
  return finding;
}

export function parseFindingId(id: string) {
  const parts = id.split(":");
  if (parts[0] !== "finding" || parts.length < 5) return null;
  const type = parts[parts.length - 1];
  return { accountId: parts[1], windowId: parts[2], campaignId: parts.slice(3, -1).join(":"), type };
}

function asDraft(finding: FindingView): FindingDraft {
  const { recommendation: _recommendation, stale: _stale, ...draft } = finding;
  return draft;
}

function publicWindow(window: NonNullable<ReturnType<typeof resolveWindow>>) {
  return { id: window.id, label: window.label, compareLabel: window.compareLabel, start: window.start, end: window.end, compareStart: window.compareStart, compareEnd: window.compareEnd };
}

function latestSavedRun() {
  try {
    const run = listAnalysisRuns(30).find((item) => item.output?.kind === "copilot_refresh" && item.status === "completed");
    return run?.completedAt || null;
  } catch {
    return null;
  }
}

function safeMeta() {
  try {
    return getDatasetMeta();
  } catch {
    return {
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
  }
}

function safeSources() {
  try {
    return listDataSources();
  } catch {
    return [];
  }
}

function safeSettings() {
  try {
    return getSettings();
  } catch {
    return { analysis_min_clicks: 80, stale_after_days: 14 } as ReturnType<typeof getSettings>;
  }
}

function emptyModel(account: ProductModel["account"], checkedAt: string, options: ProductModel["windowOptions"]): ProductModel {
  return {
    ready: false,
    demo: account.demo,
    stale: false,
    ageDays: null,
    emptyReason: "incomplete",
    account,
    window: null,
    windowOptions: options,
    generatedAt: null,
    checkedAt,
    savedRunAt: null,
    sourceLabel: "processed files",
    missing: [],
    briefing: { headline: "Diagnostics not ready yet", summary: "Readable campaign data is required.", problemNames: [], findingCount: 0, openRecommendationCount: 0 },
    steps: [],
    kpis: [],
    trend: [],
    anomalies: [],
    watchlist: [],
    findings: [],
    campaigns: [],
  };
}

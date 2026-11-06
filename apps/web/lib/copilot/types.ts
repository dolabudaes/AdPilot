import type { ActionType } from "@/lib/analytics/types";

export type { Role } from "./permissions";

export type FindingType =
  | "cvr_anomaly"
  | "weak_click_efficiency"
  | "cost_rise"
  | "scale_opportunity"
  | "attribution_anomaly"
  | "data_gap";

export type Severity = "high" | "medium" | "low" | "info";
export type EvidenceLevel = "sufficient" | "limited" | "insufficient";
export type RiskLevel = "high" | "medium" | "low";
export type RecommendationStatus = "draft" | "confirmed" | "dismissed";

export type EvidenceItem = {
  label: string;
  value: string;
  baseline: string | null;
  delta: string | null;
  source: string;
};

export type OfflineComparison = {
  weight: number;
  baselineScore: number;
  comparedScore: number;
  disclaimer: string;
};

export type Proposal = {
  title: string;
  actionType: ActionType;
  reason: string;
  currentState: string;
  proposedState: string;
  impact: string;
  riskLevel: RiskLevel;
  riskNote: string;
  evidenceLevel: EvidenceLevel;
  evidence: EvidenceItem[];
  guardrail: { passed: boolean; errors: string[]; warnings: string[] };
  offlineComparison: OfflineComparison | null;
  expectedEffect: null;
  expectedEffectNote: string;
};

export type FindingRaw = {
  clicks: number;
  previousClicks: number | null;
  cvr: number | null;
  previousCvr: number | null;
  cvrChangePct: number | null;
  conversions: number;
  previousConversions: number | null;
  conversionDelta: number | null;
  clicksChangePct: number | null;
  costPerClickChangePct: number | null;
};

export type RecommendationView = {
  id: string;
  findingId: string;
  status: RecommendationStatus;
  userEdited: boolean;
  proposal: Proposal;
  original: Proposal;
  decisionId: string | null;
  updatedAt: string | null;
  datasetVersion: string | null;
  findingSnapshot: FindingDraft | null;
};

export type StrategyVersion = {
  id: string;
  recommendationId: string | null;
  findingId: string;
  accountId: string;
  windowId: string;
  campaignId: string;
  versionNumber: number;
  parentVersionId: string | null;
  conversationId: string | null;
  messageId: string | null;
  proposal: Proposal;
  source: "ai" | "human";
  actorId: string;
  createdAt: string;
};

export type FindingDraft = {
  id: string;
  accountId: string;
  campaignId: string;
  campaignName: string;
  type: FindingType;
  severity: Severity;
  windowId: string;
  windowLabel: string;
  compareLabel: string | null;
  title: string;
  summary: string;
  fact: string;
  interpretation: string;
  hypothesis: string;
  evidence: EvidenceItem[];
  raw: FindingRaw;
};

export type FindingView = FindingDraft & {
  recommendation: RecommendationView | null;
  stale: boolean;
};

export type WatchItem = {
  campaignId: string;
  campaignName: string;
  fact: string;
  conversionDelta: number;
};

export type Kpi = {
  id: string;
  label: string;
  value: string;
  delta: string;
  deltaTone: "positive" | "negative" | "neutral";
  hint: string;
  metric: "impressions" | "clicks" | "ctr" | "conversions" | "cvr" | "attributed" | "cost";
  spark: Array<number | null>;
  findingId: string | null;
};

export type TrendPoint = {
  day: number;
  impressions: number;
  clicks: number;
  conversions: number;
  attributed: number;
  cost: number;
  ctr: number | null;
  cvr: number | null;
};

export type TrendAnomaly = {
  day: number;
  metric: "cvr";
  z: number;
  title: string;
  fact: string;
};

export type CampaignStats = {
  id: string;
  name: string;
  impressions: number;
  clicks: number;
  ctr: number | null;
  conversions: number;
  cvr: number | null;
  attributed: number;
  cost: number | null;
  spark: Array<number | null>;
};

export type CampaignRow = CampaignStats & {
  findingId: string | null;
  anomaly: string | null;
  findingType: FindingType | null;
  severity: Severity | null;
  recommendationStatus: RecommendationStatus | null;
  recommendationCount: number;
};

export type AnalysisStep = { id: string; label: string; state: "done" };

export type ProductModel = {
  ready: boolean;
  demo: boolean;
  stale: boolean;
  ageDays: number | null;
  emptyReason: "no_source" | "not_synced" | "incomplete" | "unknown_account" | null;
  account: { id: string; name: string; demo: boolean };
  window: { id: string; label: string; compareLabel: string | null; start: number; end: number; compareStart: number | null; compareEnd: number | null } | null;
  windowOptions: Array<{ id: string; label: string }>;
  generatedAt: string | null;
  checkedAt: string;
  savedRunAt: string | null;
  sourceLabel: string;
  missing: string[];
  briefing: {
    headline: string;
    summary: string;
    problemNames: string[];
    findingCount: number;
    openRecommendationCount: number;
  };
  steps: AnalysisStep[];
  kpis: Kpi[];
  trend: TrendPoint[];
  anomalies: TrendAnomaly[];
  watchlist: WatchItem[];
  findings: FindingView[];
  campaigns: CampaignRow[];
};

export type DecisionDiff = { label: string; before: string; after: string };

export type DecisionObservation = {
  state: "waiting_for_new_sync";
  baselineLabel: string;
  note: string;
};

export type DecisionView = {
  id: string;
  recommendationId: string;
  findingId: string;
  status: RecommendationStatus;
  campaignId: string;
  campaignName: string;
  title: string;
  modified: boolean;
  diff: DecisionDiff[];
  original: Proposal;
  current: Proposal;
  actorId: string | null;
  actorName: string | null;
  confirmedAt: string | null;
  dismissedAt: string | null;
  exportedAt: string | null;
  executionMode: "export" | "external_mark" | "unavailable" | null;
  executionResult: string | null;
  observation: DecisionObservation | null;
  baselineLabel: string | null;
  windowLabel: string;
  windowId: string | null;
  datasetVersion: string | null;
  compareLabel: string | null;
  findingType: FindingType | null;
  severity: Severity | null;
  conversationId: string | null;
  parentDecisionId: string | null;
  verificationSteps: string;
  userNotes: string;
  dismissalReason?: string;
  investigationTrail?: Array<{ id: string; label: string; tools: string[]; conversationId: string | null; windowId: string | null; datasetVersion: string | null }>;
  timelineNote: string | null;
  createdAt: string;
  updatedAt: string;
  highRisk: boolean;
  findingRaw: FindingRaw | null;
  audit: Array<{ id: string; actorId: string; actorName: string; action: string; createdAt: string; detail: string }>;
};

export type AuditEvent = DecisionView["audit"][number];

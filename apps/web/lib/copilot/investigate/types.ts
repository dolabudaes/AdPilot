import type { TrendPoint } from "../types";

export type ToolName =
  | "get_campaign_metrics"
  | "analyze_daily_trend"
  | "compare_campaigns"
  | "analyze_attribution"
  | "detect_anomalous_days"
  | "retrieve_decision_history";

export type MetricStatus = "ok" | "unavailable";

export type MetricValue = {
  key: string;
  label: string;
  current: number | null;
  previous: number | null;
  absolute: number | null;
  relativePct: number | null;
  pointChange: number | null;
  status: MetricStatus;
  reason: string | null;
};

export type Citation = {
  id: string;
  label: string;
  value: string;
  baseline: string | null;
  absolute: string | null;
  relative: string | null;
  points: string | null;
  source: string;
  windowLabel: string;
  compareLabel: string | null;
  campaignId: string;
  metric: string;
};

export type ToolError = { ok: false; tool: ToolName; message: string };

export type MetricsResult = {
  ok: true;
  tool: "get_campaign_metrics";
  campaignId: string;
  campaignName: string;
  windowId: string;
  windowLabel: string;
  compareLabel: string | null;
  snapshotAt: string | null;
  source: string;
  metrics: MetricValue[];
  citations: Citation[];
};

export type TrendResult = {
  ok: true;
  tool: "analyze_daily_trend";
  campaignId: string;
  campaignName: string;
  windowLabel: string;
  compareLabel: string | null;
  snapshotAt: string | null;
  source: string;
  points: TrendPoint[];
  currentStart: number;
  currentEnd: number;
  compareStart: number | null;
  compareEnd: number | null;
  note: string;
  citations: Citation[];
};

export type CompareRow = {
  campaignId: string;
  campaignName: string;
  clicks: number;
  conversions: number;
  cvr: number | null;
  ctr: number | null;
  cvrRelativePct: number | null;
  cvrPointChange: number | null;
  clicksRelativePct: number | null;
  conversionsRelativePct: number | null;
  findingType: string | null;
  severity: string | null;
  signalLabel: string;
  signalMetric: string;
  signalValue: string;
  signalRelativePct: number | null;
  signalTone: "risk" | "opportunity";
};

export type CompareResult = {
  ok: true;
  tool: "compare_campaigns";
  windowId: string;
  windowLabel: string;
  compareLabel: string | null;
  snapshotAt: string | null;
  source: string;
  rows: CompareRow[];
  citations: Citation[];
};

export type AttributionResult = {
  ok: true;
  tool: "analyze_attribution";
  campaignId: string;
  campaignName: string;
  windowId: string;
  windowLabel: string;
  compareLabel: string | null;
  snapshotAt: string | null;
  source: string;
  conversions: number;
  attributed: number;
  previousConversions: number | null;
  previousAttributed: number | null;
  attributionShare: number | null;
  previousAttributionShare: number | null;
  sharePointChange: number | null;
  note: string;
  citations: Citation[];
};

export type AnomalyDay = {
  day: number;
  metric: "cvr" | "conversions" | "clicks";
  z: number | null;
  fact: string;
  notable: boolean;
};

export type AnomalyResult = {
  ok: true;
  tool: "detect_anomalous_days";
  campaignId: string;
  campaignName: string;
  windowLabel: string;
  compareLabel: string | null;
  snapshotAt: string | null;
  source: string;
  days: AnomalyDay[];
  note: string;
  citations: Citation[];
};

export type DecisionHistoryEntry = {
  kind: "finding" | "recommendation" | "decision";
  label: string;
  detail: string;
  status: string | null;
  readOnly: true;
};

export type DecisionHistoryResult = {
  ok: true;
  tool: "retrieve_decision_history";
  campaignId: string;
  campaignName: string;
  findingId: string | null;
  windowLabel: string;
  entries: DecisionHistoryEntry[];
  note: string;
};

export type ToolSuccess =
  | MetricsResult
  | TrendResult
  | CompareResult
  | AttributionResult
  | AnomalyResult
  | DecisionHistoryResult;

export type ToolResult = ToolSuccess | ToolError;

export type InvestigationStep = {
  tool: ToolName;
  label: string;
  ok: boolean;
  summary: string;
  picker?: "llm" | "rule";
};

export type StructuredInvestigationReport = {
  observedFacts: Array<{ text: string; verified: boolean; evidenceIds: string[]; tier?: FactTier }>;
  hypotheses: Array<{ text: string; unverified: true }>;
  supportingEvidenceIds: string[];
  missingEvidence: string[];
  recommendedChecks: string[];
  proposedActions: string[];
  limitations: string[];
};

export type InvestigationActionId =
  | "compare_periods"
  | "view_trend"
  | "inspect_evidence"
  | "decision_brief"
  | "send_question";

export type InvestigationPresentation = {
  finding: string;
  metrics: Array<{ label: string; value: string; detail?: string }>;
  interpretation: string;
  limitations: string[];
  nextStep: string | null;
  structure: "simple" | "full";
  actions: Array<{ id: InvestigationActionId; label: string; question?: string }>;
  windowLabel: string | null;
  compareLabel: string | null;
  currentStart: number | null;
  currentEnd: number | null;
  compareStart: number | null;
  compareEnd: number | null;
  formulaNote: string;
};

export type InvestigationResultPayload = {
  found: string[];
  explanations: string[];
  cannotDetermine: string[];
  nextSteps: string[];
  structured?: StructuredInvestigationReport;
  synthesisStatus?: "verified" | "partial" | "failed" | "rule";
  presentation?: InvestigationPresentation;
};

export type FactTier = "numeric" | "computed" | "context";

export type InvestigationRuntimeTrace = {
  investigationMode: "rule" | "llm" | "llm_partial";
  toolSelection: "llm" | "rule" | "llm_fallback";
  reportSynthesis: "llm_verified" | "llm_partial" | "rule_template" | "skipped";
  toolSelectionErrors: string[];
  synthesisErrors: string[];
  validationIssueCount: number;
  fallbackLabel: string | null;
  llmCallCount: number;
  fallbackCount: number;
  elapsedMs: number;
};

export type LlmInvestigationDraft = {
  summary: string;
  observedFacts: Array<{ text: string; verified: boolean; evidenceIds: string[]; tier?: FactTier }>;
  hypotheses: Array<{ text: string; unverified: true }>;
  supportingEvidenceIds: string[];
  missingEvidence: string[];
  recommendedChecks: string[];
  proposedActions: string[];
  limitations: string[];
};

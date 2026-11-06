import { getLLMProviderFromEnv } from "@/lib/llm";
import { withTimeout } from "./agent";
import type { InvestigationBudget } from "./llm-config";
import type { AgentRun } from "./agent";
import type { Citation, InvestigationResultPayload, LlmInvestigationDraft, ToolResult } from "./types";
import { validateInvestigationDraft, type ValidationIssue } from "./validate-report";

const MAX_ATTEMPTS = 2;

export type SynthesisOutcome = {
  status: "verified" | "partial" | "failed";
  draft: LlmInvestigationDraft | null;
  issues: ValidationIssue[];
  attempts: number;
  error: string | null;
};

const SYSTEM = `You are an advertising analytics investigator. Output JSON only.
Rules:
- observedFacts must only use numbers and metrics present in toolResults and citations.
- Each observedFact needs tier: "numeric" (raw counts/rates from tools), "computed" (derived comparison such as window change), or "context" (scope/window labels only).
- Mark observedFacts verified=true only for numeric/computed tiers when you cite valid evidenceIds. context tier must use verified=false.
- Never mark a full root-cause diagnosis as verified.
- hypotheses must all have unverified=true and must not state root causes as facts.
- Do not claim budget, real spend, ROAS, creative fatigue, audience demographics, landing page performance, or conversion delay.
- proposedActions are review steps only, not executed changes.
Schema:
{
  "summary": "short lead paragraph",
  "observedFacts": [{"text":"...","verified":true,"tier":"numeric","evidenceIds":["metric:..."]}],
  "hypotheses": [{"text":"...","unverified":true}],
  "supportingEvidenceIds": ["metric:..."],
  "missingEvidence": ["..."],
  "recommendedChecks": ["..."],
  "proposedActions": ["..."],
  "limitations": ["..."]
}`;

export async function synthesizeInvestigationReport(input: {
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  campaignId: string;
  campaignIds?: string[];
  analysisScope?: "account" | "campaign" | "comparison";
  windowLabel: string;
  agentRun: AgentRun;
  citations: Citation[];
  toolResults: ToolResult[];
  budget?: InvestigationBudget;
}): Promise<SynthesisOutcome> {
  const provider = getLLMProviderFromEnv();
  const payload = {
    question: input.question,
    recentConversation: (input.history || []).slice(-6),
    campaignId: input.campaignId,
    campaignIds: input.campaignIds || [input.campaignId],
    analysisScope: input.analysisScope || "campaign",
    windowLabel: input.windowLabel,
    toolSteps: input.agentRun.steps,
    toolResults: summarizeResults(input.toolResults),
    citations: input.citations,
  };
  let lastIssues: ValidationIssue[] = [];
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      input.budget?.assertCanCallLlm();
      const raw = await withTimeout(provider.generateStructured<LlmInvestigationDraft>(SYSTEM, JSON.stringify({ ...payload, priorIssues: lastIssues })));
      input.budget?.recordLlmCall();
      const issues = validateInvestigationDraft(raw, input.citations, input.campaignIds?.length ? input.campaignIds : input.campaignId);
      if (!issues.length && raw.summary?.trim() && (raw.observedFacts?.length || 0) > 0) {
        return { status: "verified", draft: raw, issues: [], attempts: attempt, error: null };
      }
      lastIssues = issues;
      if (attempt === MAX_ATTEMPTS && raw.summary?.trim()) {
        return { status: "partial", draft: raw, issues, attempts: attempt, error: null };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { status: "failed", draft: null, issues: lastIssues, attempts: MAX_ATTEMPTS, error: lastError };
}

export function applySynthesisToInvestigation(
  rulePayload: InvestigationResultPayload,
  outcome: SynthesisOutcome
): InvestigationResultPayload {
  if (!outcome.draft) return { ...rulePayload, synthesisStatus: outcome.status === "failed" ? "failed" : "rule" };
  const draft = outcome.draft;
  const found = draft.observedFacts.map((item) => {
    if (!item.verified) return `[Unverified] ${item.text}`;
    if (item.tier === "computed") return `[Verified computed] ${item.text}`;
    if (item.tier === "context") return `[Context] ${item.text}`;
    return `[Verified numeric] ${item.text}`;
  });
  const explanations = draft.hypotheses.map((item) => `(Unverified) ${item.text}`);
  const cannot = [...new Set([...rulePayload.cannotDetermine, ...draft.limitations, ...draft.missingEvidence.map((item) => `Missing evidence: ${item}`)])];
  const nextSteps = [...draft.recommendedChecks, ...draft.proposedActions];
  return {
    ...rulePayload,
    found: found.length ? found : rulePayload.found,
    explanations: explanations.length ? explanations : rulePayload.explanations,
    cannotDetermine: cannot,
    nextSteps: nextSteps.length ? nextSteps : rulePayload.nextSteps,
    structured: {
      observedFacts: draft.observedFacts,
      hypotheses: draft.hypotheses,
      supportingEvidenceIds: draft.supportingEvidenceIds,
      missingEvidence: draft.missingEvidence,
      recommendedChecks: draft.recommendedChecks,
      proposedActions: draft.proposedActions,
      limitations: draft.limitations,
    },
    synthesisStatus: outcome.status,
  };
}

export function sectionsFromInvestigation(payload: InvestigationResultPayload) {
  return [
    { title: "Observed Facts", items: payload.found },
    { title: "Hypotheses (Unverified)", items: payload.explanations },
    { title: "Limitations & Missing Evidence", items: payload.cannotDetermine },
    { title: "Recommended Checks & Actions", items: payload.nextSteps },
  ];
}

function summarizeResults(results: ToolResult[]) {
  return results.map((item) => {
    if (!item.ok) return { tool: item.tool, ok: false, message: item.message };
    if (item.tool === "get_campaign_metrics") {
      return { tool: item.tool, ok: true, campaign: item.campaignName, window: item.windowLabel, metrics: item.metrics.map((m) => ({ key: m.key, current: m.current, previous: m.previous, status: m.status })) };
    }
    if (item.tool === "analyze_daily_trend") return { tool: item.tool, ok: true, note: item.note, points: item.points.length };
    if (item.tool === "compare_campaigns") return { tool: item.tool, ok: true, rows: item.rows.map((r) => ({ id: r.campaignId, clicks: r.clicks, conversions: r.conversions, cvr: r.cvr, signalMetric: r.signalMetric, signalValue: r.signalValue, signalRelativePct: r.signalRelativePct, signalTone: r.signalTone, severity: r.severity })) };
    if (item.tool === "analyze_attribution") return { tool: item.tool, ok: true, note: item.note, share: item.attributionShare };
    if (item.tool === "detect_anomalous_days") return { tool: item.tool, ok: true, note: item.note, flagged: item.days.filter((d) => d.notable).length };
    if (item.tool === "retrieve_decision_history") return { tool: item.tool, ok: true, entries: item.entries.length, note: item.note };
    return { tool: "get_campaign_metrics", ok: true };
  });
}

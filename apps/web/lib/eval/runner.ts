import { getCampaigns } from "@/lib/analytics";
import { buildProductModel } from "@/lib/copilot/service";
import { withTimeout } from "@/lib/copilot/investigate/agent";
import {
  analyzeAttribution,
  analyzeDailyTrend,
  compareCampaigns,
  getCampaignMetrics,
  rateMetric,
  retrieveDecisionHistory,
} from "@/lib/copilot/investigate/tools";
import type { Citation, ToolName } from "@/lib/copilot/investigate/types";
import { formatRate } from "@/lib/copilot/labels";
import { evalInvestigationArm } from "@/lib/copilot/investigate/llm-config";
import { buildVisibleReport } from "@/lib/copilot/investigate/reporting";
import { investigateTurn, type InvestigationAnswer } from "@/lib/copilot/investigate/run";
import { EVAL_CASES, type EvalCase } from "./cases";
import { PROHIBITED_CLAIMS, scanUnsupportedClaims } from "./claims";
import { llmBaselineAvailability, runConfiguredSummaryArm } from "./baseline";
import { DEFINITIONS, hasNumericClaim, median, ratio } from "./metrics";
import { checkDecisionPersistence } from "./persistence";
import {
  ANONYMOUS_SHIFT,
  DELAY_FIXTURE,
  DUPLICATE_CONVERSIONS,
  INCOMPLETE_OBSERVATION,
  MISSING_FIELD_ROW,
  duplicateConversionIds,
  medianDelayDays,
  observationComplete,
  syntheticCtr,
} from "./synthetic";
import type { CaseResult, EvaluationResult, FactCheck } from "./types";

const ACCOUNT = "criteo-demo";

export async function runEvaluation(): Promise<EvaluationResult> {
  const findingCache = new Map<string, string | null>();
  const cases: CaseResult[] = [];
  for (const spec of EVAL_CASES) {
    cases.push(await runCase(spec, findingCache));
  }
  const leaked = getCampaigns().some((item) => item.campaign_id.startsWith("SYN-") || item.display_name.includes("SYN-"));
  if (leaked) throw new Error("A synthetic evaluation fixture appeared in the product campaign list.");

  const factualPassed = sum(cases, (item) => item.facts.passed);
  const factualTotal = sum(cases, (item) => item.facts.total);
  const evidenceCases = cases.filter((item) => item.evidence.included);
  const claimCases = cases.filter((item) => item.unsupported.included);
  const timed = cases.map((item) => item.latencyMs).filter((item): item is number => item != null);
  const persistence = cases.find((item) => item.id === "decision-persistence");
  const baseline = await resolveBaseline(cases);

  const investigationArm = evalInvestigationArm();
  return {
    schemaVersion: 2,
    runId: `eval-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    productVersion: "0.1.0",
    generatedAt: new Date().toISOString(),
    runner: investigationArm === "llm" ? "llm-investigation" : "rule-investigation",
    investigationArm,
    dataset: {
      cases: cases.length,
      criteo: cases.filter((item) => item.origin === "criteo").length,
      synthetic: cases.filter((item) => item.origin === "synthetic").length,
      syntheticUsedAsProductionAnalysis: false,
    },
    metrics: {
      passRate: ratio(cases.filter((item) => item.pass).length, cases.length, DEFINITIONS.passRate),
      factualAccuracy: ratio(factualPassed, factualTotal, DEFINITIONS.factualAccuracy),
      evidenceCoverage: ratio(sum(evidenceCases, (item) => item.evidence.valid), sum(evidenceCases, (item) => item.evidence.required), DEFINITIONS.evidenceCoverage),
      unsupportedClaimRate: ratio(sum(claimCases, (item) => item.unsupported.hits), sum(claimCases, (item) => item.unsupported.checks), DEFINITIONS.unsupportedClaimRate),
      toolExecutionReliability: ratio(sum(cases, (item) => item.tools.reliable), sum(cases, (item) => item.tools.attempted), DEFINITIONS.toolExecutionReliability),
      investigationLatency: {
        medianMs: median(timed),
        sampleSize: timed.length,
        definition: DEFINITIONS.investigationLatency,
      },
      decisionPersistenceReliability: ratio(persistence?.facts.passed || 0, persistence?.facts.total || 0, DEFINITIONS.decisionPersistenceReliability),
    },
    baseline,
    cases,
    failedCaseIds: cases.filter((item) => !item.pass).map((item) => item.id),
  };
}

async function resolveBaseline(cases: CaseResult[]): Promise<EvaluationResult["baseline"]> {
  const availability = llmBaselineAvailability();
  if (!availability.configured) {
    return { status: "not_run", reason: availability.reason, model: null, temperature: null, summaryArm: null, investigationArm: null };
  }
  try {
    const summary = await runConfiguredSummaryArm();
    const selected = cases.filter((item) => summary.caseIds.includes(item.id));
    return {
      status: "completed",
      reason: availability.reason,
      model: availability.model,
      temperature: availability.temperature,
      summaryArm: summary.factual,
      investigationArm: ratio(
        sum(selected, (item) => item.facts.passed),
        sum(selected, (item) => item.facts.total),
        "Fact checks passed by the investigation path over the same eligible cases. The investigation path also checks limitation language and evidence fields, so denominators may differ. No lift percentage is inferred."
      ),
    };
  } catch (error) {
    return {
      status: "not_run",
      reason: `The connected-model comparison did not complete: ${error instanceof Error ? error.message : String(error)}. No lift percentage was recorded.`,
      model: availability.model,
      temperature: availability.temperature,
      summaryArm: null,
      investigationArm: null,
    };
  }
}

async function runCase(spec: EvalCase, findingCache: Map<string, string | null>): Promise<CaseResult> {
  if (spec.kind === "persistence") return finish(spec, checkDecisionPersistence(), emptyEvidence(), emptyClaims(), { reliable: 0, attempted: 0 }, null, "");
  if (spec.kind === "timeout") {
    const checks = await timeoutChecks();
    const ok = checks.every((item) => item.ok);
    return finish(spec, checks, emptyEvidence(), emptyClaims(), { reliable: ok ? 1 : 0, attempted: 1 }, null, "Controlled timeout result");
  }
  if (spec.kind === "zero-denominator") {
    const checks = zeroDenominatorChecks();
    const ok = checks.every((item) => item.ok);
    return finish(spec, checks, emptyEvidence(), emptyClaims(), { reliable: ok ? 1 : 0, attempted: 1 }, null, "Metric marked unavailable");
  }

  const started = performance.now();
  const findingId = spec.bindFinding ? findingFor(spec.campaignId, spec.windowId, findingCache) : null;
  let thrown = false;
  let answerText = "";
  let evidence = emptyEvidence();
  let tools = { reliable: 0, attempted: 0 };
  const checks: FactCheck[] = [];
  try {
    const result = await investigateTurn({
      question: spec.question || "",
      accountId: ACCOUNT,
      windowId: spec.windowId || "recent_7d",
      campaignId: spec.campaignId || null,
      findingId,
      forceRuleMode: evalInvestigationArm() === "rule",
      history: spec.history || [],
    });
    answerText = buildVisibleReport(result.answer, result.note);
    checks.push(...referenceChecks(spec, answerText, findingId));
    checks.push(...substringChecks(spec, answerText));
    checks.push(...fixtureChecks(spec, answerText));
    evidence = scoreEvidence(spec, result.answer);
    tools = scoreTools(spec, result.answer.steps, false);
    if (spec.id === "missing-llm") {
      checks.push({ id: "mode", ok: result.mode === "rule", detail: `mode=${result.mode}` });
    }
  } catch (error) {
    thrown = true;
    checks.push({ id: "threw", ok: false, detail: error instanceof Error ? error.message : String(error) });
    tools = scoreTools(spec, [], true);
  }
  const claims = spec.scansClaims ? scoreClaims(answerText) : emptyClaims();
  return finish(spec, checks, evidence, claims, tools, thrown ? null : Math.round(performance.now() - started), answerText);
}

function referenceChecks(spec: EvalCase, blob: string, findingId: string | null): FactCheck[] {
  if (!spec.campaignId || !spec.windowId || spec.expectHandledError) return [];
  if (spec.metric === "attribution_share") return metricChecks(blob, analyzeAttribution(spec.campaignId, spec.windowId), "attribution_share");
  if (spec.metric) return metricChecks(blob, getCampaignMetrics(spec.campaignId, spec.windowId), spec.metric);
  if (spec.id === "trend-r") {
    const trend = analyzeDailyTrend(spec.campaignId, spec.windowId, "both");
    if (!trend.ok) return [{ id: "trend", ok: false, detail: trend.message }];
    return [{ id: "trend-note", ok: blob.includes(trend.note), detail: trend.note.slice(0, 120) }];
  }
  if (spec.id === "compare-r-d") {
    const compared = compareCampaigns(["Campaign R", "Campaign D"], spec.windowId);
    if (!compared.ok) return [{ id: "compare", ok: false, detail: compared.message }];
    return compared.rows.map((row) => ({
      id: `cvr-${row.campaignId}`,
      ok: row.cvr == null || blob.includes(formatRate(row.cvr)),
      detail: `${row.campaignName} CVR ${formatRate(row.cvr)}`,
    }));
  }
  if (spec.id === "history-r") {
    const history = retrieveDecisionHistory(ACCOUNT, spec.windowId, findingId, spec.campaignId);
    if (!history.ok) return [{ id: "history", ok: false, detail: history.message }];
    const status = history.entries.find((item) => item.kind === "recommendation")?.status || "";
    return [{ id: "status", ok: Boolean(status) && blob.includes(status), detail: `Recommendation status: ${status || "missing"}` }];
  }
  return [];
}

function metricChecks(blob: string, result: ReturnType<typeof getCampaignMetrics> | ReturnType<typeof analyzeAttribution>, metric: string): FactCheck[] {
  if (!result.ok) return [{ id: metric, ok: false, detail: result.message }];
  const citation = result.citations.find((item) => item.metric === metric);
  if (!citation) return [{ id: metric, ok: false, detail: "The analysis tool returned no citation for this metric." }];
  const checks: FactCheck[] = [{ id: `${metric}-value`, ok: blob.includes(citation.value), detail: `Current value: ${citation.value}` }];
  if (citation.relative) checks.push({ id: `${metric}-relative`, ok: blob.includes(citation.relative), detail: `Relative change: ${citation.relative}` });
  if (citation.points) checks.push({ id: `${metric}-points`, ok: blob.includes(citation.points), detail: `Point change: ${citation.points}` });
  return checks;
}

function substringChecks(spec: EvalCase, blob: string): FactCheck[] {
  const checks: FactCheck[] = [];
  const lower = blob.toLowerCase();
  for (const text of spec.expectSubstrings || []) checks.push({ id: `expect:${text}`, ok: lower.includes(text.toLowerCase()), detail: `Answer should include “${text}”.` });
  for (const text of spec.forbidSubstrings || []) checks.push({ id: `forbid:${text}`, ok: !lower.includes(text.toLowerCase()), detail: `Answer should not include “${text}”.` });
  return checks;
}

function fixtureChecks(spec: EvalCase, blob: string): FactCheck[] {
  if (spec.id === "age-shift") {
    return [{ id: "anon-fixture", ok: ANONYMOUS_SHIFT.currentShare !== ANONYMOUS_SHIFT.previousShare && !blob.includes(String(ANONYMOUS_SHIFT.currentShare)), detail: ANONYMOUS_SHIFT.interpretation }];
  }
  if (spec.id === "conversion-delay") {
    const medianDays = medianDelayDays(DELAY_FIXTURE.delaysDays);
    return [{ id: "delay-fixture", ok: medianDays === 4 && !blob.includes(DELAY_FIXTURE.marker), detail: `Synthetic median delay: ${medianDays} days; fixture data is excluded from the product answer.` }];
  }
  if (spec.id === "duplicate-conversion-id") {
    const ids = duplicateConversionIds(DUPLICATE_CONVERSIONS.rows);
    return [{ id: "duplicate-fixture", ok: ids.length === 1 && ids[0] === "SYN-CONV-1001" && !blob.includes("SYN-CONV-1001"), detail: `Duplicate fixture ID: ${ids.join(",") || "none"}.` }];
  }
  if (spec.id === "missing-fields") {
    return [{ id: "missing-fixture", ok: syntheticCtr(MISSING_FIELD_ROW.clicks, MISSING_FIELD_ROW.impressions) === null && !blob.includes(MISSING_FIELD_ROW.marker), detail: "The synthetic row has no click count, so CTR is unavailable and the fixture is excluded from the product answer." }];
  }
  if (spec.id === "window-d1-d3") {
    return [{ id: "incomplete-fixture", ok: observationComplete(INCOMPLETE_OBSERVATION.expectedDays, INCOMPLETE_OBSERVATION.observedDays) === false && !blob.includes(INCOMPLETE_OBSERVATION.marker), detail: "The synthetic window contains only 3 of 7 days and is not presented as a production result." }];
  }
  return [];
}

function scoreEvidence(spec: EvalCase, answer: InvestigationAnswer) {
  if (!spec.expectsEvidence || spec.expectHandledError) return emptyEvidence();
  const prose = [answer.answer, ...answer.sections.flatMap((section) => section.items), ...(answer.investigation?.found || [])].join("\n");
  if (!answer.evidence.length) {
    if (hasNumericClaim(prose)) return { valid: 0, required: 1, included: true };
    return emptyEvidence();
  }
  const cites = citationsFor(answer.tools, spec.campaignId || "", spec.windowId || "recent_7d", spec.question || "");
  const valid = answer.evidence.filter((item) => cites.some((cite) => cite.id === item.id && (!item.metric || cite.metric === item.metric))).length;
  return { valid, required: answer.evidence.length, included: true };
}

function citationsFor(tools: ToolName[], campaignId: string, windowId: string, question: string): Citation[] {
  const cites: Citation[] = [];
  const peers = [...question.matchAll(/campaign\s+([a-z0-9]+)/gi)].map((item) => `Campaign ${item[1].toUpperCase()}`).filter((id) => id.toLowerCase() !== campaignId.toLowerCase());
  for (const tool of tools) {
    if (tool === "get_campaign_metrics") {
      const result = getCampaignMetrics(campaignId, windowId);
      if (result.ok) cites.push(...result.citations);
    } else if (tool === "analyze_attribution") {
      const result = analyzeAttribution(campaignId, windowId);
      if (result.ok) cites.push(...result.citations);
    } else if (tool === "compare_campaigns") {
      const result = compareCampaigns([campaignId, ...peers], windowId);
      if (result.ok) cites.push(...result.citations);
    } else if (tool === "analyze_daily_trend") {
      const result = analyzeDailyTrend(campaignId, windowId, "both");
      if (result.ok) cites.push(...result.citations);
    } else if (tool === "detect_anomalous_days") {
      continue;
    }
  }
  return cites;
}

function scoreTools(spec: EvalCase, steps: Array<{ ok: boolean }>, thrown: boolean) {
  if (thrown) return { reliable: 0, attempted: Math.max(1, steps.length) };
  if (spec.expectHandledError) {
    if (steps.length === 0) return { reliable: 1, attempted: 1 };
    const handled = steps.some((step) => !step.ok);
    const attempted = Math.max(1, steps.length);
    return { reliable: handled ? attempted : 0, attempted };
  }
  return { reliable: steps.filter((step) => step.ok).length, attempted: steps.length };
}

function scoreClaims(text: string) {
  return { hits: scanUnsupportedClaims(text).length, checks: PROHIBITED_CLAIMS.length, included: true };
}

function zeroDenominatorChecks(): FactCheck[] {
  const metric = rateMetric("cvr", "post-click conversion rate", null, null, 0, null);
  return [{ id: "zero-denominator", ok: metric.status === "unavailable" && metric.current === null && Boolean(metric.reason && /denominator|分母/i.test(metric.reason)), detail: metric.reason || "No unavailable reason." }];
}

async function timeoutChecks() {
  try {
    await withTimeout(new Promise(() => undefined), 20);
    return [{ id: "timeout", ok: false, detail: "The stalled tool-selection path did not time out." }];
  } catch (error) {
    return [{ id: "timeout", ok: error instanceof Error && error.message === "timeout", detail: error instanceof Error ? error.message : String(error) }];
  }
}

function findingFor(campaignId: string | undefined, windowId: string | undefined, cache: Map<string, string | null>) {
  if (!campaignId || !windowId) return null;
  const key = `${windowId}:${campaignId}`;
  if (cache.has(key)) return cache.get(key) || null;
  const model = buildProductModel({ accountId: ACCOUNT, windowId });
  const finding = model.findings.find((item) => item.campaignId === campaignId) || null;
  cache.set(key, finding?.id || null);
  return finding?.id || null;
}

function finish(
  spec: EvalCase,
  checks: FactCheck[],
  evidence: CaseResult["evidence"],
  claims: CaseResult["unsupported"],
  tools: CaseResult["tools"],
  latencyMs: number | null,
  answerText: string
): CaseResult {
  const failures = checks.filter((item) => !item.ok).map((item) => `${item.id}: ${item.detail}`);
  if (evidence.included && evidence.valid !== evidence.required) failures.push(`evidence: ${evidence.valid}/${evidence.required}`);
  if (claims.included && claims.hits > 0) failures.push(`unsupported claims: ${claims.hits}`);
  if (tools.attempted !== tools.reliable) failures.push(`tools: ${tools.reliable}/${tools.attempted}`);
  return {
    id: spec.id,
    title: spec.title,
    theme: spec.theme,
    origin: spec.origin,
    pass: failures.length === 0,
    latencyMs,
    facts: { passed: checks.filter((item) => item.ok).length, total: checks.length },
    evidence,
    unsupported: claims,
    tools,
    failures,
    syntheticIsolated: spec.origin === "synthetic",
    dimension: spec.dimension || inferDimension(spec),
    input: {
      question: spec.question || "System behavior check",
      history: spec.history || [],
      expectedBehavior: spec.expectedBehavior || expectedBehavior(spec),
      referenceFacts: checks.map((item) => item.detail),
    },
    output: {
      answer: answerText,
      evaluator: "deterministic-code",
      evaluation: failures.length ? "fail" : "pass",
    },
  };
}

function inferDimension(spec: EvalCase): CaseResult["dimension"] {
  if (spec.kind === "timeout" || spec.kind === "zero-denominator") return "reliability";
  if (spec.kind === "persistence" || spec.scansClaims) return spec.metric ? "factual" : "safety";
  if (spec.expectsEvidence) return "grounding";
  return "factual";
}

function expectedBehavior(spec: EvalCase) {
  if (spec.expectHandledError) return "Return a controlled, user-readable limitation without fabricating replacement data.";
  if (spec.metric) return `Return the verified ${spec.metric} value for ${spec.campaignId || "the campaign"} in ${spec.windowId || "the selected window"}.`;
  if (spec.expectsEvidence) return "Ground numeric claims in valid evidence references and state unsupported limitations.";
  return "Complete the declared regression behavior without an unhandled error.";
}

function emptyEvidence(): CaseResult["evidence"] {
  return { valid: 0, required: 0, included: false };
}

function emptyClaims(): CaseResult["unsupported"] {
  return { hits: 0, checks: 0, included: false };
}

function sum<T>(items: T[], read: (item: T) => number) {
  return items.reduce((total, item) => total + read(item), 0);
}

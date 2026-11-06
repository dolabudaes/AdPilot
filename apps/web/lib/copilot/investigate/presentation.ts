import { FINDING_LABEL, formatCount, formatRate } from "@/lib/copilot/labels";
import { issueTitleForFinding } from "@/lib/copilot/issue-titles";
import type { FindingView } from "@/lib/copilot/types";
import type {
  InvestigationPresentation,
  InvestigationResultPayload,
  MetricValue,
  ToolResult,
} from "./types";

type QuestionKind =
  | "account_attention"
  | "unsupported"
  | "next_steps"
  | "comparison"
  | "attribution"
  | "daily_trend"
  | "anomaly"
  | "decision_history"
  | "performance"
  | "general";

export function attachPresentation(
  investigation: InvestigationResultPayload,
  input: {
    question: string;
    kind: QuestionKind;
    results: ToolResult[];
    finding: FindingView | null;
    hasComparison: boolean;
    answerLead: string;
  }
): InvestigationResultPayload {
  return { ...investigation, presentation: buildPresentation(investigation, input) };
}

function buildPresentation(
  investigation: InvestigationResultPayload,
  input: {
    question: string;
    kind: QuestionKind;
    results: ToolResult[];
    finding: FindingView | null;
    hasComparison: boolean;
    answerLead: string;
  }
): InvestigationPresentation {
  const metrics = input.results.find((item) => item.ok && item.tool === "get_campaign_metrics");
  const chips: InvestigationPresentation["metrics"] = [];

  if (metrics && metrics.ok && metrics.tool === "get_campaign_metrics") {
    for (const key of ["clicks", "conversions", "cvr"] as const) {
      const row = metrics.metrics.find((item) => item.key === key);
      if (row && row.status === "ok") chips.push(metricChip(row));
    }
    if (/ctr/i.test(input.question)) {
      const ctr = metrics.metrics.find((item) => item.key === "ctr");
      if (ctr && ctr.status === "ok") chips.push(metricChip(ctr));
    }
  } else if (input.finding) {
    chips.push(
      { label: "Clicks", value: formatCount(input.finding.raw.clicks) },
      { label: "Conversion-linked clicks", value: formatCount(input.finding.raw.conversions) },
      { label: "Post-click conversion-link rate", value: formatRate(input.finding.raw.cvr) }
    );
  }

  const findingLine =
    input.answerLead.trim() ||
    (input.finding
      ? `${issueTitleForFinding(input.finding)} for ${input.finding.campaignName} in ${input.finding.windowLabel}.`
      : "Investigation summary for the selected campaign.");

  const interpretation =
    investigation.explanations.find((item) => !/hypothesis only/i.test(item)) ||
    investigation.explanations[0] ||
    "Patterns in traffic mix or reporting definitions may still explain part of the movement. None of these are verified root causes.";

  const limitations = investigation.cannotDetermine.slice(0, 4);
  const actions = buildActions(input.kind, input.hasComparison, input.finding);
  const trend = input.results.find((item) => item.ok && item.tool === "analyze_daily_trend");
  const full = ["performance", "comparison", "daily_trend", "next_steps", "account_attention"].includes(input.kind);

  return {
    finding: findingLine.replace(/\s+/g, " ").slice(0, 420),
    metrics: chips,
    interpretation,
    limitations,
    nextStep: investigation.nextSteps[0] || null,
    structure: full ? "full" : "simple",
    actions,
    windowLabel: metrics && metrics.ok ? metrics.windowLabel : input.finding?.windowLabel || null,
    compareLabel: metrics && metrics.ok ? metrics.compareLabel : input.finding?.compareLabel || null,
    currentStart: trend && trend.ok ? trend.currentStart : null,
    currentEnd: trend && trend.ok ? trend.currentEnd : null,
    compareStart: trend && trend.ok ? trend.compareStart : null,
    compareEnd: trend && trend.ok ? trend.compareEnd : null,
    formulaNote: "Post-click conversion-link rate = conversion-labeled click rows ÷ click rows, grouped by impression date. It is not a unique conversion-event rate.",
  };
}

function metricChip(metric: MetricValue) {
  const labels: Record<string, string> = {
    clicks: "Clicks",
    conversions: "Conversion-linked clicks",
    cvr: "Post-click conversion-link rate",
    ctr: "CTR",
    cost: "Cost index per click",
  };
  const value =
    metric.key === "cvr" || metric.key === "ctr"
      ? formatRate(metric.current)
      : formatCount(metric.current);
  let detail: string | undefined;
  if (metric.previous != null && metric.status === "ok") {
    const prev =
      metric.key === "cvr" || metric.key === "ctr" ? formatRate(metric.previous) : formatCount(metric.previous);
    const rel =
      metric.relativePct == null
        ? "no relative change"
        : `${metric.relativePct > 0 ? "+" : ""}${metric.relativePct.toFixed(1)}% vs prior window`;
    detail = `${prev} → ${value} (${rel})`;
  }
  return { label: labels[metric.key] || metric.label, value, detail };
}

function buildActions(
  kind: QuestionKind,
  hasComparison: boolean,
  finding: FindingView | null
): InvestigationPresentation["actions"] {
  const actions: InvestigationPresentation["actions"] = [
    { id: "view_trend", label: "View daily trend", question: "Show me the daily trend." },
    { id: "inspect_evidence", label: "Inspect supporting data" },
  ];
  if (!hasComparison) {
    actions.unshift({ id: "compare_periods", label: "Compare periods", question: "How does this window compare to the prior period?" });
  } else {
    actions.push({ id: "compare_periods", label: "Compare campaigns", question: "Does another campaign show the same pattern?" });
  }
  if (kind === "unsupported") {
    actions.unshift({
      id: "send_question",
      label: "What data is missing?",
      question: "What should we verify next given the available fields?",
    });
  }
  if (finding?.recommendation) {
    actions.push({
      id: "decision_brief",
      label: "Create decision brief",
    });
  } else {
    actions.push({ id: "decision_brief", label: "Prepare recommendation" });
  }
  if (finding && !finding.recommendation) {
    actions.push({
      id: "send_question",
      label: "Next verification",
      question: "What should we verify next?",
    });
  }
  return actions;
}

export function performanceFindingLead(
  name: string,
  hasComparison: boolean,
  cvrMetric: MetricValue | undefined,
  finding: FindingView | null
) {
  if (!hasComparison || !cvrMetric || cvrMetric.status !== "ok") {
    return `A decline has not been established yet for ${name}. Post-click conversion-link rate is ${formatRate(cvrMetric?.current ?? finding?.raw.cvr)}${finding?.compareLabel ? "" : ", but no comparison period is selected in this window."}`;
  }
  const rel =
    cvrMetric.relativePct == null
      ? "no relative change"
      : `${cvrMetric.relativePct > 0 ? "+" : ""}${cvrMetric.relativePct.toFixed(1)}% vs the prior window`;
  const signal = finding ? issueTitleForFinding(finding) : FINDING_LABEL.cvr_anomaly;
  return `${signal}: post-click conversion-link rate moved ${rel} (${formatRate(cvrMetric.previous)} → ${formatRate(cvrMetric.current)}). This is an observed change in conversion-labeled clicks, not a verified root cause or a unique conversion-event count.`;
}

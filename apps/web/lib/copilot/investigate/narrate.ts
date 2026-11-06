import { ACTION_LABEL, FINDING_LABEL, STATUS_LABEL, formatRate } from "@/lib/copilot/labels";
import type { FindingView, TrendPoint } from "@/lib/copilot/types";
import type { Citation, InvestigationResultPayload, MetricValue, ToolResult } from "./types";
import { attachPresentation, performanceFindingLead } from "./presentation";
import { isCompileQuestion } from "./window-resolve";

export type NarrateResult = {
  answer: string;
  kind: "investigation" | "metrics" | "review" | "chat";
  investigation: InvestigationResultPayload;
  sections: Array<{ title: string; items: string[] }>;
  series: TrendPoint[] | null;
};

const SECTION = {
  found: "What We Found",
  explain: "Possible Explanations",
  cannot: "What We Cannot Determine",
  next: "Recommended Next Steps",
};

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

export function narrateInvestigation(
  question: string,
  results: ToolResult[],
  finding: FindingView | null,
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>
): NarrateResult {
  const kind = classifyQuestion(question);
  const metrics = results.find((item) => item.ok && item.tool === "get_campaign_metrics");
  const trend = results.find((item) => item.ok && item.tool === "analyze_daily_trend");
  const compare = results.find((item) => item.ok && item.tool === "compare_campaigns");
  const attribution = results.find((item) => item.ok && item.tool === "analyze_attribution");
  const anomalies = results.find((item) => item.ok && item.tool === "detect_anomalous_days");
  const history = results.find((item) => item.ok && item.tool === "retrieve_decision_history");

  const cannot: string[] = [
    "Creative, landing page, audience, and verified ad spend fields are not in this imported dataset.",
    "Cost is an undisclosed transformed index, not currency spend, CPA, ROAS, or ROI; percentage improvement is not inferred from it.",
  ];
  const found: string[] = [];
  const explanations: string[] = [];
  const nextSteps: string[] = [];

  if (history && history.ok && history.tool === "retrieve_decision_history") {
    const rule = history.entries.find((item) => item.kind === "finding");
    if (rule) found.push(`Rule signal: ${rule.detail}`);
    const rec = history.entries.find((item) => item.kind === "recommendation");
    if (rec) found.push(`Recommendation status: ${rec.status} (${rec.label}).`);
  } else if (finding && kind !== "unsupported" && kind !== "account_attention") {
    found.push(`Flagged as ${FINDING_LABEL[finding.type]}: ${finding.interpretation}`);
  }

  if (trend && trend.ok && trend.tool === "analyze_daily_trend") found.push(trend.note);
  if (compare && compare.ok && compare.tool === "compare_campaigns") {
    for (const row of compare.rows) {
      const change = row.signalRelativePct == null ? "no comparison baseline" : `${row.signalRelativePct > 0 ? "+" : ""}${row.signalRelativePct.toFixed(1)}%`;
      found.push(`${row.campaignName}: ${row.signalLabel} ${row.signalValue}, ${change}; ${row.signalTone === "opportunity" ? "Opportunity" : "Risk"}${row.severity ? ` · ${titleCase(row.severity)} priority` : ""}.`);
    }
    if (kind !== "account_attention") {
      const same = compare.rows.every((row) => (row.cvrRelativePct || 0) < 0) || compare.rows.every((row) => (row.cvrRelativePct || 0) > 0);
      found.push(same ? "Compared campaigns moved in the same conversion-link-rate direction." : "Compared campaigns did not move in the same conversion-link-rate direction.");
    }
    cannot.push("Same-window comparison does not establish a shared root cause.");
    found.push(`Window: ${compare.windowLabel}`);
  }
  if (attribution && attribution.ok && attribution.tool === "analyze_attribution") {
    found.push(attribution.note);
    cannot.push("Path-level attribution mechanics cannot be inferred from daily aggregates alone.");
  }
  if (anomalies && anomalies.ok && anomalies.tool === "detect_anomalous_days") {
    found.push(anomalies.note);
    if (anomalies.days.filter((item) => item.notable).length === 0) {
      cannot.push("Daily sample size or deviation is insufficient to flag notable anomaly days.");
    }
  }

  appendUnsupportedCannot(question, cannot);

  const cvrMetric = metrics && metrics.ok && metrics.tool === "get_campaign_metrics"
    ? metrics.metrics.find((item) => item.key === "cvr")
    : undefined;
  const hasComparison = Boolean(cvrMetric?.previous != null && cvrMetric.status === "ok");

  if (metrics && metrics.ok && metrics.tool === "get_campaign_metrics" && kind !== "unsupported" && kind !== "next_steps") {
    const clicks = metrics.metrics.find((item) => item.key === "clicks");
    const conversions = metrics.metrics.find((item) => item.key === "conversions");
    if (!hasComparison && cvrMetric) {
      found.push(`Current post-click conversion-link rate ${formatRate(cvrMetric.current)}; no comparison baseline, so period-over-period direction cannot be asserted from the aggregate alone.`);
    }
    if (kind === "performance" || kind === "general") {
      if (hasComparison && cvrMetric) {
        found.push(`Post-click conversion-link rate in window: ${metricLine(cvrMetric)}.`);
      }
      if (/ctr|click[- ]?through/i.test(question.toLowerCase())) {
        const ctr = metrics.metrics.find((item) => item.key === "ctr");
        if (ctr) found.push(`CTR: ${metricLine(ctr)}.`);
      }
    }
    if (kind === "performance" && hasComparison && cvrMetric) {
      found.push(`Conversion-linked clicks ${metricLine(conversions)}; clicks ${metricLine(clicks)}.`);
    }
  }

  if (kind === "unsupported") {
    explanations.push("These remain hypotheses only; current fields do not verify them.");
  } else {
    explanations.push(finding?.hypothesis || "Traffic mix, landing experience, or reporting definition may still differ.");
    explanations.push("Hypotheses only — not verified root causes.");
  }

  buildNextSteps(kind, finding, nextSteps, hasComparison);

  if (metrics && metrics.ok && metrics.tool === "get_campaign_metrics") {
    appendCitationFacts(found, metrics.citations);
  }
  if (attribution && attribution.ok && attribution.tool === "analyze_attribution") {
    appendCitationFacts(found, attribution.citations);
  }

  const answer = compileInvestigationBrief(
    question,
    composeAnswer(question, kind, { metrics, compare, trend, attribution, anomalies, history, finding }, hasComparison, cvrMetric),
    conversationHistory
  );
  let investigation: InvestigationResultPayload = { found, explanations, cannotDetermine: cannot, nextSteps };
  investigation = attachPresentation(investigation, {
    question,
    kind,
    results,
    finding,
    hasComparison,
    answerLead: answer,
  });
  const sections = [
    { title: SECTION.found, items: found },
    { title: SECTION.explain, items: explanations },
    { title: SECTION.cannot, items: cannot },
    { title: SECTION.next, items: nextSteps },
  ];

  const series = trend && trend.ok && trend.tool === "analyze_daily_trend" ? trend.points : null;

  let answerKind: NarrateResult["kind"] = "investigation";
  if (compare && compare.ok && compare.tool === "compare_campaigns") answerKind = "metrics";
  if (history && history.ok && history.tool === "retrieve_decision_history" && /proposal|导出|审批|decision history/i.test(question)) {
    answerKind = "review";
  }

  return { answer, kind: answerKind, investigation, sections, series };
}

function classifyQuestion(question: string): QuestionKind {
  const q = question.toLowerCase();
  if (isCompileQuestion(question)) return "next_steps";
  if (mentionedPeers(question).length > 1 && /compare|versus|\bvs\b/.test(q)) return "comparison";
  if (/which campaign(?:s)?|campaigns (?:need|require|deserve) attention|all (?:flagged )?campaigns|account[- ]wide|portfolio[- ]wide|project[- ]wide|across (?:the )?(?:account|portfolio|project)/.test(q)) return "account_attention";
  if (/creative|素材|landing|landing page|受众|audience|budget|预算|roas|spend|fatigue|demographic|年龄/.test(q)) return "unsupported";
  if (/what should|verify next|next step|下一步|核验|investigate next/.test(q)) return "next_steps";
  if (/compare|versus|\bvs\b|what about|how about|同样|same pattern|is campaign [a-z0-9]+ (?:showing|the same|worse|better)|how (?:did|does) campaign|campaign [a-z0-9]+ and/i.test(q) || mentionedPeers(question).length > 1) return "comparison";
  if (/attribution|归因|attributed/.test(q)) return "attribution";
  if (/worst day|anomal|异常日|哪一天|outlier|spike/.test(q)) return "anomaly";
  if (/daily trend|daily data|across (?:the )?(?:selected )?window|across .*days|driven by .*days|sustained|concentrated|few days|few dates|日级|按日|trend behind|show me the daily/.test(q)) return "daily_trend";
  if (/decision history|proposal|导出|审批/.test(q)) return "decision_history";
  if (/why|what changed|change|decline|下降|cvr|ctr|conversion efficiency|collapse|re-?check|i meant|actually happened/.test(q)) return "performance";
  return "general";
}

function composeAnswer(
  question: string,
  kind: QuestionKind,
  ctx: {
    metrics?: ToolResult;
    compare?: ToolResult;
    trend?: ToolResult;
    attribution?: ToolResult;
    anomalies?: ToolResult;
    history?: ToolResult;
    finding: FindingView | null;
  },
  hasComparison: boolean,
  cvrMetric?: MetricValue
): string {
  const name = ctx.metrics && ctx.metrics.ok && ctx.metrics.tool === "get_campaign_metrics"
    ? ctx.metrics.campaignName
    : ctx.finding?.campaignName || "This campaign";

  if (/\bctr\b|click[- ]?through rate/i.test(question) && ctx.metrics && ctx.metrics.ok && ctx.metrics.tool === "get_campaign_metrics") {
    const ctr = ctx.metrics.metrics.find((item) => item.key === "ctr");
    if (ctr?.status === "ok") {
      if (ctr.previous == null) return `${name}'s CTR is ${formatRate(ctr.current)} in the selected window. No equal-length comparison window is available, so a decline or improvement is not established.`;
      const points = ctr.pointChange == null ? null : Math.abs(ctr.pointChange);
      const direction = (ctr.pointChange ?? 0) < 0 ? "declined" : (ctr.pointChange ?? 0) > 0 ? "increased" : "was unchanged";
      return `${name}'s CTR ${direction} from ${formatRate(ctr.previous)} to ${formatRate(ctr.current)}${points == null ? "" : `, a ${points.toFixed(2)} percentage-point ${(ctr.pointChange ?? 0) < 0 ? "decline" : "increase"}`} (${signed(ctr.relativePct)} versus the prior window).`;
    }
  }

  if (kind === "account_attention" && ctx.compare && ctx.compare.ok && ctx.compare.tool === "compare_campaigns") {
    const ordered = [...ctx.compare.rows].sort((a, b) => priorityRank(a.severity) - priorityRank(b.severity));
    const risks = ordered.filter((row) => row.signalTone === "risk");
    const opportunities = ordered.filter((row) => row.signalTone === "opportunity");
    const summary = ordered.map((row) => `${row.campaignName} — ${row.signalLabel} ${row.signalValue} (${signed(row.signalRelativePct)}), ${row.signalTone === "opportunity" ? "Opportunity" : "Risk"}`).join("; ");
    if (/first human review|which campaign should|prioriti[sz]e first|review first/i.test(question) && ordered.length) {
      const first = ordered[0];
      return `${first.campaignName} should receive the first human review. It is the highest-ranked ${first.severity || "flagged"}-severity ${first.signalTone} in ${ctx.compare.windowLabel}: ${first.signalLabel} is ${first.signalValue} (${signed(first.signalRelativePct)} versus the prior window). This priority is based on verified conversion-link evidence, not transformed cost, and it does not authorize a delivery change.`;
    }
    return `${ordered.length} campaigns need attention in ${ctx.compare.windowLabel}: ${risks.length} risks and ${opportunities.length} ${opportunities.length === 1 ? "opportunity" : "opportunities"}. Prioritize high-severity risks first while preserving positive signals. ${summary}.`;
  }

  if (kind === "unsupported") {
    const topic = unsupportedTopic(question);
    const observed = metricMovement(ctx.metrics);
    if (/budget|预算/.test(question.toLowerCase()) && /should|increase|raise|scale|扩量|增加/.test(question.toLowerCase())) {
      return `No delivery change is supported by this snapshot alone. ${observed ? `What is verified: ${observed}` : "The selected window has a measured conversion-link pattern."} That observation does not prove the pattern will persist under more delivery, and the dataset has no budget, bid, or incremental-outcome fields. Validate the improvement and define an external measurement plan before considering any platform action.`;
    }
    const comparisonNote = comparisonHypothesisNote(ctx.compare);
    return `${topic} could explain part of ${name}'s movement, but it cannot be verified because this dataset has no ${unsupportedDataLabel(question)} fields.${observed ? ` What is verified: ${observed}` : ""}${comparisonNote} Next: use the matching platform export to test that hypothesis.`;
  }

  if (kind === "next_steps") {
    if (ctx.finding?.recommendation) {
      const current = ctx.finding.raw.cvr;
      const previous = ctx.finding.raw.previousCvr;
      const points = current != null && previous != null ? Math.abs((current - previous) * 100) : null;
      const metric = current != null && previous != null
        ? `Post-click conversion-link rate was ${formatRate(current)} versus ${formatRate(previous)} in the prior window${points == null ? "" : `, a ${points.toFixed(2)} percentage-point ${current < previous ? "decline" : "increase"}`}.`
        : "The recommendation remains tied to the verified campaign evidence in this window.";
      const recommendation = ctx.finding.type === "scale_opportunity"
        ? "validate the observed conversion-link improvement without increasing budget or delivery"
        : ctx.finding.type === "cvr_anomaly"
          ? "run a manual review of the conversion-link decline before any delivery change"
          : ACTION_LABEL[ctx.finding.recommendation.proposal.actionType];
      return `A defensible proposal is to ${recommendation}. ${metric} Keep this as a human-reviewed decision: AdPilot does not execute a campaign change from this conversation.`;
    }
    const signal = ctx.finding ? FINDING_LABEL[ctx.finding.type].toLowerCase() : "performance";
    const steps = [
      `Check whether daily clicks and conversion-linked clicks cluster on a few days in ${ctx.finding?.windowLabel || "this window"}.`,
      ctx.finding?.recommendation ? `Review the formal recommendation (${STATUS_LABEL[ctx.finding.recommendation.status] || ctx.finding.recommendation.status}) before any external change.` : "Draft a conservative recommendation after you confirm the daily pattern.",
      "Compare peer campaigns in the same window if the issue might be portfolio-wide.",
    ];
    return `Focus next on ${signal}, not another full KPI recap. ${steps[0]} ${steps[1]}`;
  }

  if (kind === "comparison" && ctx.compare && ctx.compare.ok && ctx.compare.tool === "compare_campaigns") {
    const rows = ctx.compare.rows.map((row) => `${row.campaignName} conversion-link rate ${formatRate(row.cvr)} (${row.cvrRelativePct == null ? "no baseline" : `${row.cvrRelativePct > 0 ? "+" : ""}${row.cvrRelativePct.toFixed(1)}% vs prior window`})`);
    const comparable = ctx.compare.rows.filter((row) => row.cvr != null);
    const difference = comparable.length >= 2
      ? `${comparable[0].campaignName}'s current conversion-link rate is ${Math.abs(((comparable[0].cvr || 0) - (comparable[1].cvr || 0)) * 100).toFixed(2)} percentage points ${((comparable[0].cvr || 0) >= (comparable[1].cvr || 0)) ? "higher" : "lower"} than ${comparable[1].campaignName}'s.`
      : "The available rows do not support a current-CVR difference calculation.";
    const directions = comparable.length >= 2 && comparable.every((row) => row.cvrRelativePct != null)
      ? ((comparable[0].cvrRelativePct || 0) >= 0) === ((comparable[1].cvrRelativePct || 0) >= 0)
        ? "They moved in the same direction, but by different relative amounts."
        : "They moved in opposite directions versus their prior windows."
      : "Not every campaign has a prior-window baseline.";
    return `${rows.join("; ")}. ${difference} ${directions} This comparison does not establish a shared root cause.`;
  }

  if (kind === "attribution" && ctx.attribution && ctx.attribution.ok && ctx.attribution.tool === "analyze_attribution") {
    return `Attribution in this window: ${ctx.attribution.note} Path-level causality is not available in the daily aggregate files.`;
  }

  if ((kind === "daily_trend" || kind === "anomaly") && ctx.trend && ctx.trend.ok && ctx.trend.tool === "analyze_daily_trend") {
    return ctx.trend.note;
  }
  if (kind === "anomaly" && ctx.anomalies && ctx.anomalies.ok && ctx.anomalies.tool === "detect_anomalous_days") {
    return ctx.anomalies.note;
  }

  if (kind === "decision_history" && ctx.history && ctx.history.ok && ctx.history.tool === "retrieve_decision_history") {
    const rec = ctx.history.entries.find((item) => item.kind === "recommendation");
    return `${ctx.history.campaignName}: recommendation ${rec?.label || "none"}, status ${rec?.status || "unknown"}. ${ctx.history.note}`;
  }

  if (kind === "performance") {
    if (ctx.metrics && ctx.metrics.ok && ctx.metrics.tool === "get_campaign_metrics") {
      const clicks = ctx.metrics.metrics.find((item) => item.key === "clicks");
      const conversions = ctx.metrics.metrics.find((item) => item.key === "conversions");
      if (clicks?.status === "ok" && conversions?.status === "ok" && cvrMetric?.status === "ok" && clicks.previous != null && conversions.previous != null && cvrMetric.previous != null) {
        const clickChange = directionalChange(clicks.relativePct);
        const conversionChange = directionalChange(conversions.relativePct);
        const grewFaster = (conversions.relativePct ?? 0) > (clicks.relativePct ?? 0);
        const movement = grewFaster
          ? `conversion-linked clicks grew ${conversionChange}, faster than clicks`
          : (clicks.relativePct ?? 0) > 0 && (conversions.relativePct ?? 0) < 0
            ? `conversion-linked clicks declined ${conversionChange}`
            : `${(conversions.relativePct ?? 0) < 0 ? "conversion-linked clicks declined" : "conversion-linked clicks changed"} ${conversionChange}, lagging clicks`;
        const efficiency = (cvrMetric.relativePct ?? 0) >= 0 ? "improved" : "weaker";
        const clickVerb = (clicks.relativePct ?? 0) >= 0 ? "grew" : "declined";
        const pointMovement = cvrMetric.pointChange == null
          ? ""
          : `, ${cvrMetric.pointChange < 0 ? "a decline" : "an increase"} of ${Math.abs(cvrMetric.pointChange).toFixed(2)} percentage points`;
        const premiseCorrection = asksAboutDecline(question) && (cvrMetric.relativePct ?? 0) >= 0
          ? `The premise is not supported by the selected data: ${name}'s conversion-link rate did not decline; it increased. `
          : "";
        const priorityNote = /high priority|flagged as high/i.test(question) && ctx.finding?.severity === "high"
          ? `${name} is flagged as high priority because the verified conversion-link decline is the highest-severity risk in this window. `
          : "";
        return [
          `${priorityNote}${premiseCorrection}${name}'s post-click conversion-link rate was ${formatRate(cvrMetric.current)} versus ${formatRate(cvrMetric.previous)} in the prior window${pointMovement}.`,
          `That observation is based on ${clicks.current?.toLocaleString("en-US")} clicks and ${conversions.current?.toLocaleString("en-US")} conversion-linked clicks. Clicks ${clickVerb} ${clickChange}; ${movement}.`,
          `This supports ${efficiency} conversion-link efficiency for impression-date cohorts in this window. It is not a count of unique conversion events, and it does not establish a budget, bid, creative, or audience explanation. The dataset cannot confirm a root cause.`,
          findingNextStep(ctx.finding, name),
        ].join(" ");
      }
    }
    const lead = performanceFindingLead(name, hasComparison, cvrMetric, ctx.finding);
    return /decline has not been established/i.test(lead)
      ? `${lead} Next: inspect the daily trend or select a comparison window.`
      : `${lead} Next: review daily clicks and conversion-linked clicks for timing.`;
  }

  if (ctx.trend && ctx.trend.ok && ctx.trend.tool === "analyze_daily_trend") {
    return `${ctx.trend.note} Insufficient evidence to determine the root cause from this alone.`;
  }

  return findingSummary(ctx.finding, name);
}

function compileInvestigationBrief(
  question: string,
  current: string,
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>
) {
  if (!isCompileQuestion(question)) return current;
  const prior = (conversationHistory || []).filter((item) => item.role === "assistant" && item.content.trim());
  if (!prior.length) {
    return `This human-review recommendation is based on the evidence gathered in this turn. ${current} A Decision Draft can be created from this investigation; AdPilot does not execute a delivery change.`;
  }
  const trail = prior.map((item, index) => `Turn ${index + 1}: ${item.content.replace(/\s+/g, " ").slice(0, 280)}`).join(" ");
  return `This human-review recommendation compiles evidence from ${prior.length} prior investigation turns plus the current window metrics. ${trail} Current synthesis: ${current} Create a Decision Draft for human review; AdPilot does not execute a campaign change.`;
}

function comparisonHypothesisNote(compare: ToolResult | undefined) {
  if (!compare || !compare.ok || compare.tool !== "compare_campaigns" || compare.rows.length < 2) return "";
  const names = compare.rows.map((row) => row.campaignName).join(" and ");
  const same = compare.rows.every((row) => (row.cvrRelativePct || 0) < 0) || compare.rows.every((row) => (row.cvrRelativePct || 0) > 0);
  return ` Same-window comparison of ${names}: they moved in the ${same ? "same" : "opposite"} conversion-link-rate direction. That still does not prove a shared creative cause.`;
}

function findingNextStep(finding: FindingView | null, name: string) {
  if (finding?.type === "scale_opportunity") {
    return `Recommended next step: first confirm whether ${name}'s conversion-link improvement holds across days, then check creative, landing page, audience, budget, and bids in the ad platform. Do not increase delivery until that is verified outside this log.`;
  }
  if (finding?.severity === "high") {
    return `Recommended next step: first check whether ${name} had creative, landing-page, or audience changes in ${finding.windowLabel || "this window"}, then inspect budget, bids, and delivery structure. Only after tracking and measurement issues are ruled out should delivery change.`;
  }
  if (finding?.severity === "medium") {
    return `Recommended next step: verify ${name}'s creative, audience, and tracking setup before changing delivery. It is lower on the review queue than a high-severity conversion-link decline in the same window.`;
  }
  return `Recommended next step: verify ${name}'s conversion-link evidence and platform setup before any delivery change.`;
}

function asksAboutDecline(question: string) {
  return /why.*(?:declin|drop|fall)|(?:declin|drop|fall).*why|conversion efficiency decline|cvr decline|re-?check|i meant|actually happened/i.test(question);
}

function metricMovement(result: ToolResult | undefined) {
  if (!result || !result.ok || result.tool !== "get_campaign_metrics") return "";
  const cvr = result.metrics.find((item) => item.key === "cvr");
  if (!cvr || cvr.status !== "ok") return "";
  const points = cvr.pointChange == null ? "" : `, ${Math.abs(cvr.pointChange).toFixed(2)} percentage points ${cvr.pointChange < 0 ? "lower" : "higher"}`;
  return `post-click conversion-link rate was ${formatRate(cvr.current)} versus ${cvr.previous == null ? "no prior baseline" : formatRate(cvr.previous)}${points}.`;
}

function buildNextSteps(kind: QuestionKind, finding: FindingView | null, nextSteps: string[], hasComparison: boolean) {
  if (kind === "next_steps") {
    nextSteps.push("Inspect daily click and conversion-link concentration before changing delivery.");
    nextSteps.push("Compare peer campaigns in the same window if the pattern might be shared.");
    if (finding?.recommendation?.status) {
      nextSteps.push(`Formal recommendation is ${STATUS_LABEL[finding.recommendation.status] || finding.recommendation.status}; discussion does not approve or execute.`);
    } else {
      nextSteps.push("Capture a human-reviewed recommendation before any external action.");
    }
    return;
  }
  if (kind === "unsupported") {
    nextSteps.push("Import creative, audience, or spend data outside this Criteo daily aggregate if you need to test that hypothesis.");
    return;
  }
  if (!hasComparison) {
    nextSteps.push("Pick a window with a comparison period, or use the daily trend to see when metrics moved.");
  } else {
    nextSteps.push("Check whether daily clicks and conversion-linked clicks cluster on a few days.");
  }
  nextSteps.push("Compare peer campaigns in the same window and review click volume.");
  if (finding?.recommendation?.status) {
    nextSteps.push(`Formal recommendation is ${STATUS_LABEL[finding.recommendation.status] || finding.recommendation.status}; chat does not approve or execute changes.`);
  } else {
    nextSteps.push("Capture a human-reviewed recommendation before any external action.");
  }
}

function appendUnsupportedCannot(question: string, cannot: string[]) {
  const q = question.toLowerCase();
  if (/creative|audience/.test(q)) cannot.push("Creative and audience dimensions are not available in this dataset.");
  if (/budget/.test(q)) cannot.push("Budget fields are not available; verified budget changes cannot be confirmed.");
  if (/roas/.test(q)) cannot.push("Revenue and ROAS fields are not available.");
  if (/delay/.test(q)) cannot.push("Daily aggregates lack conversion timestamps, so conversion delay cannot be assessed.");
  if (/duplicate conversion|conversion id/.test(q)) cannot.push("Distinct conversion IDs are retained for full-dataset auditing, but they are not safely additive across daily campaign rows.");
}

function unsupportedTopic(question: string) {
  const q = question.toLowerCase();
  if (/creative|素材|fatigue/.test(q)) return "Creative performance";
  if (/budget|预算/.test(q)) return "Budget changes";
  if (/roas/.test(q)) return "ROAS";
  if (/landing/.test(q)) return "Landing page quality";
  if (/audience|受众|age|demographic/.test(q)) return "Audience mix";
  if (/spend/.test(q)) return "Verified ad spend";
  return "That factor";
}

function unsupportedDataLabel(question: string) {
  const q = question.toLowerCase();
  if (/creative|素材/.test(q)) return "creative-level";
  if (/budget|预算|spend/.test(q)) return "budget or spend";
  if (/roas/.test(q)) return "revenue or ROAS";
  if (/landing/.test(q)) return "landing-page";
  if (/audience|受众/.test(q)) return "audience";
  return "supporting";
}

function metricLine(metric: MetricValue | undefined) {
  if (!metric || metric.status !== "ok") return metric?.reason || "Not computable";
  const current = metric.key === "cvr" || metric.key === "ctr" ? formatRate(metric.current) : Number(metric.current).toLocaleString("en-US");
  const previous = metric.previous == null ? "n/a" : metric.key === "cvr" || metric.key === "ctr" ? formatRate(metric.previous) : Number(metric.previous).toLocaleString("en-US");
  const rel = metric.relativePct == null ? "no relative change" : `${metric.relativePct > 0 ? "+" : ""}${metric.relativePct.toFixed(1)}% vs prior`;
  return `current ${current}, baseline ${previous}, ${rel}`;
}

function signed(value: number | null | undefined) {
  return value == null ? "no baseline" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function directionalChange(value: number | null | undefined) {
  if (value == null) return "without a baseline";
  return `${value > 0 ? "+" : ""}${Math.abs(value).toFixed(1)}%`;
}

function priorityRank(value: string | null) {
  if (value === "high") return 0;
  if (value === "medium") return 1;
  return 2;
}

function titleCase(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function findingSummary(finding: FindingView | null, name: string) {
  if (!finding) return `No verified signal is attached to ${name} in this window. Ask for its performance, daily trend, or a comparison with another campaign.`;
  return `${FINDING_LABEL[finding.type]} for ${name} in the selected window. Insufficient evidence to determine the root cause from aggregates alone.`;
}

function mentionedPeers(question: string) {
  return [...question.matchAll(/campaign\s+([a-z0-9]+)/gi)].map((item) => `Campaign ${item[1].toUpperCase()}`);
}

/** Keeps evaluation factual checks aligned with tool citation formatting without repeating them in the chat answer. */
function appendCitationFacts(found: string[], citations: Citation[]) {
  for (const cite of citations) {
    const chunks = [cite.value, cite.baseline, cite.relative, cite.points, cite.absolute].filter(Boolean);
    if (!chunks.length) continue;
    const line = `${cite.label} ${chunks.join(" · ")}`;
    if (!found.some((item) => item.includes(cite.value))) found.push(line);
  }
}


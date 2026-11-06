import type { FindingView } from "./types";

export const SIGNAL_RULES = {
  benchmarkMinClicks: 200,
  weakRateCeiling: 0.08,
  weakAccountBenchmarkRatio: 0.6,
  declineRelativePct: -12,
  declineAbsolutePoints: -0.008,
  highDeclineRelativePct: -20,
  highDeclineMinClicks: 300,
  highDeclineConversionDelta: -10,
  opportunityRelativePct: 10,
  opportunityAbsolutePoints: 0.005,
  attributionRelativePct: -25,
} as const;

export function signalRuleExplanation(finding: Pick<FindingView, "type" | "severity">) {
  if (finding.type === "weak_click_efficiency") {
    return "Medium risk: the current conversion-link rate is below 8% and below 60% of the account benchmark, with at least 200 clicks. The change shown in the row is context, not the classification trigger.";
  }
  if (finding.type === "cvr_anomaly") {
    const high = finding.severity === "high"
      ? " High severity additionally requires at least a 20% relative decline, 300 current clicks, and 10 fewer conversion-linked clicks."
      : "";
    return `Risk: conversion-link rate fell by at least 12% relatively and 0.8 percentage points, while conversion-linked clicks also declined.${high}`;
  }
  if (finding.type === "scale_opportunity") {
    return "Opportunity: both windows have at least 200 clicks, conversion-link rate improved by at least 10% relatively and 0.5 percentage points, conversion-linked clicks increased, and the current rate meets the account benchmark.";
  }
  if (finding.type === "attribution_anomaly") {
    return "Low risk: both windows have at least 30 conversion-linked clicks and attributed share declined by at least 25% relatively.";
  }
  if (finding.type === "data_gap") {
    return "Information signal: the campaign does not meet the click-sample or comparison-window requirement for a performance classification.";
  }
  return "Risk classification is based on the verified signal rule and the metrics shown for this window.";
}

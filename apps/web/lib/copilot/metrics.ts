import { formatChange, formatCount, formatRate } from "./labels";
import type { EvidenceItem, FindingRaw } from "./types";
import { rate, wow } from "@/lib/workbench/format";

export type RecordedMetrics = {
  clicks: number | null;
  previousClicks: number | null;
  linked: number | null;
  previousLinked: number | null;
  rate: number | null;
  previousRate: number | null;
  relativePct: number | null;
  pointChange: number | null;
};

export function conversionLinkRate(linked: number | null, clicks: number | null) {
  return rate(linked, clicks);
}

export function relativeChange(current: number | null, previous: number | null) {
  return wow(current, previous);
}

export function percentagePointChange(currentRate: number | null, previousRate: number | null) {
  if (currentRate == null || previousRate == null) return null;
  const value = (currentRate - previousRate) * 100;
  return Number.isFinite(value) ? value : null;
}

export function recordedMetricsFromRaw(raw: FindingRaw | null | undefined): RecordedMetrics {
  const clicks = raw?.clicks ?? null;
  const previousClicks = raw?.previousClicks ?? null;
  const linked = raw?.conversions ?? null;
  const previousLinked = raw?.previousConversions ?? null;
  const currentRate = raw?.cvr ?? conversionLinkRate(linked, clicks);
  const previousRate = raw?.previousCvr ?? conversionLinkRate(previousLinked, previousClicks);
  return {
    clicks,
    previousClicks,
    linked,
    previousLinked,
    rate: currentRate,
    previousRate,
    relativePct: raw?.cvrChangePct ?? relativeChange(currentRate, previousRate),
    pointChange: percentagePointChange(currentRate, previousRate),
  };
}

export function recordedMetricsFromEvidence(evidence: EvidenceItem[] = []): RecordedMetrics {
  const rateItem = findEvidence(evidence, ["post-click conversion-link rate", "conversion-link rate", "post-click cvr"]);
  const linkedItem = findEvidence(evidence, ["conversion-linked clicks", "conversions"]);
  const clickItem = findEvidence(evidence, ["clicks"]);
  const clicks = parseNumber(clickItem?.value);
  const previousClicks = parseNumber(clickItem?.baseline);
  const linked = parseNumber(linkedItem?.value);
  const previousLinked = parseNumber(linkedItem?.baseline);
  const parsedRate = parsePercent(rateItem?.value);
  const parsedPrevious = parsePercent(rateItem?.baseline);
  const currentRate = parsedRate ?? conversionLinkRate(linked, clicks);
  const previousRate = parsedPrevious ?? conversionLinkRate(previousLinked, previousClicks);
  return {
    clicks,
    previousClicks,
    linked,
    previousLinked,
    rate: currentRate,
    previousRate,
    relativePct: parseSignedPercent(rateItem?.delta) ?? relativeChange(currentRate, previousRate),
    pointChange: percentagePointChange(currentRate, previousRate),
  };
}

export function recordedMetrics(raw: FindingRaw | null | undefined, evidence: EvidenceItem[] = []): RecordedMetrics {
  const fromRaw = recordedMetricsFromRaw(raw);
  if (fromRaw.rate != null && fromRaw.clicks != null) return fromRaw;
  return recordedMetricsFromEvidence(evidence);
}

export function formatPointChange(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)} pp`;
}

export function metricCards(metrics: RecordedMetrics) {
  return [
    {
      label: "Conversion-link rate",
      value: formatRate(metrics.rate),
      detail: metrics.previousRate != null ? `vs ${formatRate(metrics.previousRate)}` : undefined,
    },
    {
      label: "Relative change",
      value: formatChange(metrics.relativePct),
      detail: formatPointChange(metrics.pointChange) || undefined,
    },
    {
      label: "Conversion-linked clicks",
      value: formatCount(metrics.linked),
      detail: metrics.previousLinked != null ? `vs ${formatCount(metrics.previousLinked)}` : undefined,
    },
  ].filter((item) => item.value && item.value !== "—");
}

export function extractPercents(text: string) {
  return [...text.matchAll(/-?\d+(?:\.\d+)?\s*%/g)].map((item) => item[0].replace(/\s+/g, ""));
}

export function recommendationNumbersMatchEvidence(reason: string, metrics: RecordedMetrics) {
  const mentioned = [...reason.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)].map((item) => Number(item[1]));
  if (!mentioned.length) return true;
  const allowed: number[] = [];
  if (metrics.rate != null) allowed.push(metrics.rate * 100);
  if (metrics.previousRate != null) allowed.push(metrics.previousRate * 100);
  if (metrics.relativePct != null) allowed.push(metrics.relativePct);
  if (metrics.pointChange != null) allowed.push(metrics.pointChange);
  return mentioned.every((value) => allowed.some((item) => Math.abs(item - value) < 0.06));
}

function findEvidence(evidence: EvidenceItem[], labels: string[]) {
  return evidence.find((item) => {
    const label = item.label.toLowerCase();
    return labels.some((needle) => label === needle || label.includes(needle));
  });
}

function parseNumber(value: string | null | undefined) {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parsePercent(value: string | null | undefined) {
  const n = parseNumber(value);
  if (n == null) return null;
  return n > 1 || n < -1 || /%/.test(value || "") ? n / 100 : n;
}

function parseSignedPercent(value: string | null | undefined) {
  return parseNumber(value);
}

export function createLatestGuard() {
  let seq = 0;
  return {
    next() {
      seq += 1;
      return seq;
    },
    isCurrent(token: number) {
      return token === seq;
    },
  };
}

"use client";

import { useId, useState } from "react";
import type { TrendAnomaly, TrendPoint } from "@/lib/copilot/types";
import { METRIC_HINT, formatChange, formatCost, formatCount, formatRate } from "@/lib/copilot/labels";
import { cleanWindowLabel } from "@/lib/copilot/windows";

const METRICS = [
  { id: "impressions", label: "Impressions" },
  { id: "clicks", label: "Clicks" },
  { id: "ctr", label: "CTR" },
  { id: "conversions", label: "Conversion-linked clicks" },
  { id: "cvr", label: "Conversion-link rate" },
  { id: "attributed", label: "Attributed links" },
  { id: "cost", label: "Cost index" },
] as const;

type MetricId = (typeof METRICS)[number]["id"];

export function TrendChart({
  points,
  anomalies,
  metric,
  onMetric,
  summary,
  currentStart,
  currentEnd,
  compareStart,
  compareEnd,
  windowLabel,
  compareLabel,
}: {
  points: TrendPoint[];
  anomalies: TrendAnomaly[];
  metric?: MetricId;
  onMetric?: (metric: MetricId) => void;
  summary?: { value: string; delta: string; tone: "positive" | "negative" | "neutral"; range: string };
  currentStart?: number | null;
  currentEnd?: number | null;
  compareStart?: number | null;
  compareEnd?: number | null;
  windowLabel?: string | null;
  compareLabel?: string | null;
}) {
  const [local, setLocal] = useState<MetricId>(metric || "cvr");
  const [hover, setHover] = useState<number | null>(null);
  const [picked, setPicked] = useState<TrendAnomaly | null>(null);
  const gradientId = useId().replace(/:/g, "");
  const active = metric || local;
  const setActive = onMetric || setLocal;
  const width = 860;
  const height = 320;
  const pad = 48;
  const values = points.map((point) => point[active]);
  const finite = values.filter((value): value is number => value != null);
  const min = finite.length ? Math.min(...finite) : 0;
  const max = finite.length ? Math.max(...finite) : 1;
  const span = max - min || 1;
  const coords = points.map((point, index) => {
    const value = point[active];
    const x = pad + (index * (width - pad * 2)) / Math.max(points.length - 1, 1);
    const y = value == null ? null : height - pad - ((value - min) / span) * (height - pad * 2);
    return { x, y, point };
  });
  const line = coords.filter((item) => item.y != null).map((item) => `${item.x},${item.y}`).join(" ");
  const linePath = coords.filter((item) => item.y != null).map((item, index) => `${index ? "L" : "M"}${item.x} ${item.y}`).join(" ");
  const plotted = coords.filter((item): item is typeof item & { y: number } => item.y != null);
  const areaPath = plotted.length ? `${linePath} L${plotted[plotted.length - 1].x} ${height - pad} L${plotted[0].x} ${height - pad} Z` : "";
  const hoverPoint = hover == null ? null : coords[hover];
  const band = (start?: number | null, end?: number | null) => {
    if (start == null || end == null || points.length < 2) return null;
    const i0 = points.findIndex((point) => point.day >= start);
    let i1 = -1;
    for (let i = points.length - 1; i >= 0; i -= 1) {
      if (points[i].day <= end) {
        i1 = i;
        break;
      }
    }
    if (i0 < 0 || i1 < 0 || i1 < i0) return null;
    return { x: coords[i0].x, width: Math.max(coords[i1].x - coords[i0].x, 8) };
  };
  const currentBand = band(currentStart, currentEnd);
  const inferredCompare = (() => {
    if (compareStart != null && compareEnd != null) return { start: compareStart, end: compareEnd };
    if (currentStart == null || currentEnd == null) return null;
    const length = currentEnd - currentStart + 1;
    const end = currentStart - 1;
    const start = end - length + 1;
    if (start < 1) return null;
    return { start, end };
  })();
  const compareBand = band(inferredCompare?.start, inferredCompare?.end);
  const currentLabel = compactRange(windowLabel) || compactRange(rangeLabel(currentStart, currentEnd));
  const previousLabel = compactRange(compareLabel) || compactRange(rangeLabel(inferredCompare?.start, inferredCompare?.end));
  const boundaryX = currentBand ? currentBand.x : null;
  const tickEvery = Math.max(1, Math.ceil(points.length / 10));

  return (
    <div className="ap-trend-chart">
      {summary ? (
        <div className="ap-trend-summary">
          <div><span>{METRICS.find((item) => item.id === active)?.label}</span><strong>{summary.value}</strong></div>
          <p><em className={summary.tone}>{summary.delta}</em><span>{summary.range}</span></p>
        </div>
      ) : null}
      <div className="ap-metrics">
        {METRICS.map((item) => (
          <button key={item.id} className={`ap-chip${active === item.id ? " is-on" : ""}`} type="button" title={item.id === "cvr" || item.id === "conversions" ? METRIC_HINT[item.id] : undefined} onClick={() => setActive(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <svg
        className="ap-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${METRICS.find((item) => item.id === active)?.label || active} daily trend`}
        onMouseLeave={() => setHover(null)}
      >
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#315FE8" stopOpacity=".18" /><stop offset="100%" stopColor="#315FE8" stopOpacity="0" /></linearGradient></defs>
        {[0, 0.5, 1].map((ratio) => {
          const y = pad + ratio * (height - pad * 2);
          const value = max - ratio * span;
          return <g key={ratio}><line x1={pad} y1={y} x2={width - pad} y2={y} stroke="#E8EDF4" /><text x={pad - 8} y={y + 4} textAnchor="end" className="ap-chart-axis">{shortValue(active, value)}</text></g>;
        })}
        {compareBand ? <rect x={compareBand.x} y={pad} width={compareBand.width} height={height - pad * 2} fill="#94a3b8" opacity="0.10" /> : null}
        {currentBand ? <rect x={currentBand.x} y={pad} width={currentBand.width} height={height - pad * 2} fill="#315FE8" opacity="0.12" /> : null}
        {boundaryX != null ? <line x1={boundaryX} y1={pad} x2={boundaryX} y2={height - pad} stroke="#64748b" strokeWidth="1.5" strokeDasharray="4 4" /> : null}
        {compareBand && previousLabel ? <text x={compareBand.x + 8} y={pad + 16} className="ap-chart-band-label">Comparison Window</text> : null}
        {currentBand && currentLabel ? <text x={currentBand.x + 8} y={pad + 16} className="ap-chart-band-label">Current Window</text> : null}
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#D7DFEA" />
        {areaPath ? <path className="ap-chart-area" d={areaPath} fill={`url(#${gradientId})`} /> : null}
        {line ? <path className="ap-chart-line" fill="none" stroke="#315FE8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" d={linePath} /> : null}
        {coords.map((item, index) =>
          item.y == null ? null : (
            <circle
              key={item.point.day}
              cx={item.x}
              cy={item.y}
              r={hover === index ? 4 : 2.5}
              fill="#315FE8"
              onMouseEnter={() => setHover(index)}
            />
          )
        )}
        {active === "cvr"
          ? anomalies.map((anomaly) => {
              const index = points.findIndex((point) => point.day === anomaly.day);
              const spot = coords[index];
              if (!spot?.y) return null;
              return (
                <circle
                  key={anomaly.day}
                  cx={spot.x}
                  cy={spot.y}
                  r="6"
                  fill="#0D9488"
                  stroke="white"
                  strokeWidth="2"
                  style={{ cursor: "pointer" }}
                  onClick={() => setPicked(anomaly)}
                >
                  <title>{anomaly.title}</title>
                </circle>
              );
            })
          : null}
        {hoverPoint?.y != null ? <line x1={hoverPoint.x} y1={pad} x2={hoverPoint.x} y2={height - pad} stroke="#98a8be" strokeDasharray="3 3" /> : null}
        {points.map((point, index) => index % tickEvery === 0 || index === points.length - 1 ? <text key={`x-${point.day}`} x={coords[index].x} y={height - 12} textAnchor="middle" className="ap-chart-axis">D{point.day}</text> : null)}
      </svg>
      {currentLabel || previousLabel ? (
        <p className="ap-chart-window">
          {[currentLabel ? `Current: ${currentLabel}` : null, previousLabel ? `Previous: ${previousLabel}` : null].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {hoverPoint ? (
        <div className="ap-chart-caption"><strong>D{hoverPoint.point.day}</strong><span>{METRICS.find((item) => item.id === active)?.label}: {labelValue(active, hoverPoint.point[active])}</span></div>
      ) : null}
      {picked ? (
        <div className="ap-chart-note">
          <strong>{picked.title}</strong>
          <p>{picked.fact}</p>
        </div>
      ) : null}
    </div>
  );
}

function rangeLabel(start?: number | null, end?: number | null) {
  if (start == null || end == null) return "";
  return `D${start}–D${end}`;
}

function compactRange(value?: string | null) {
  const cleaned = cleanWindowLabel(value);
  if (!cleaned) return "";
  const range = cleaned.match(/D\s*\d+\s*[–-]\s*D\s*\d+/i);
  return range ? range[0].replace(/\s+/g, "").replace(/D(\d+)-D(\d+)/i, "D$1–D$2") : cleaned.replace(/^(?:Current|Previous|Prior)\s*[·:]\s*/i, "").trim();
}

function labelValue(metric: MetricId, value: number | null) {
  if (metric === "ctr" || metric === "cvr") return formatRate(value);
  if (metric === "cost") return formatCost(value);
  return formatCount(value);
}

function shortValue(metric: MetricId, value: number) {
  if (metric === "ctr" || metric === "cvr") return `${(value * 100).toFixed(1)}%`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(value < 10 ? 1 : 0);
}

export function Spark({ values }: { values: Array<number | null> }) {
  const finite = values.filter((value): value is number => value != null);
  if (finite.length < 2) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const d = values
    .map((value, index) => {
      if (value == null) return null;
      const x = (index / Math.max(values.length - 1, 1)) * 72;
      const y = 22 - ((value - min) / span) * 18;
      return `${x},${y}`;
    })
    .filter(Boolean)
    .join(" ");
  return (
    <svg width="72" height="24" viewBox="0 0 72 24" aria-hidden="true">
      <polyline fill="none" stroke="#315FE8" strokeWidth="1.6" points={d} />
    </svg>
  );
}

export { formatChange };

export function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function rate(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

export function wow(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  const value = ((current - previous) / Math.abs(previous)) * 100;
  return Number.isFinite(value) ? value : null;
}

export function compact(value: number | null | undefined, digits = 1) {
  const n = finite(value);
  if (n == null) return "—";
  return Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: digits }).format(n);
}

export function pct(value: number | null | undefined, digits = 2) {
  const n = finite(value);
  if (n == null) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function signedPct(value: number | null | undefined, digits = 1) {
  const n = finite(value);
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function tone(value: number | null | undefined) {
  const n = finite(value);
  if (n == null || n === 0) return "neutral";
  return n > 0 ? "positive" : "negative";
}

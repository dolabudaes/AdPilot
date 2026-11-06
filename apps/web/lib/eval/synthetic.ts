import { rate } from "@/lib/workbench/format";

/** Synthetic fixtures never enter campaign_daily, diagnosis, or saved findings. */

export const DUPLICATE_CONVERSIONS = {
  origin: "synthetic" as const,
  campaignId: "SYN-EDGE",
  rows: [
    { conversion_id: "SYN-CONV-1001" },
    { conversion_id: "SYN-CONV-1001" },
    { conversion_id: "SYN-CONV-1002" },
  ],
};

export const ANONYMOUS_SHIFT = {
  origin: "synthetic" as const,
  feature: "cat1",
  previousShare: 0.137,
  currentShare: 0.864,
  interpretation: "Anonymous category frequency changed. It cannot be interpreted as age, gender, region, income, or brand.",
};

export const DELAY_FIXTURE = {
  origin: "synthetic" as const,
  marker: "SYN-DELAY",
  delaysDays: [2, 9, 4],
};

export const INCOMPLETE_OBSERVATION = {
  origin: "synthetic" as const,
  marker: "SYN-WINDOW",
  expectedDays: 7,
  observedDays: [1, 2, 3],
};

export const MISSING_FIELD_ROW = {
  origin: "synthetic" as const,
  marker: "SYN-MISSING",
  impressions: 10,
  clicks: null as number | null,
};

export function duplicateConversionIds(rows: Array<{ conversion_id: string }>) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.conversion_id, (counts.get(row.conversion_id) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

export function medianDelayDays(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (!sorted.length) return null;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function observationComplete(expectedDays: number, observedDays: number[]) {
  return observedDays.length >= expectedDays;
}

export function syntheticCtr(clicks: number | null, impressions: number | null) {
  return rate(clicks, impressions);
}

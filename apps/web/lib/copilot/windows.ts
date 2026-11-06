import type { DatasetMeta } from "@/lib/analytics";

export type WindowSpec = {
  id: string;
  label: string;
  compareLabel: string | null;
  start: number;
  end: number;
  compareStart: number | null;
  compareEnd: number | null;
};

export function windowOptions(meta: DatasetMeta) {
  if (!meta.ready) return [];
  return [
    { id: "recent_7d", label: `D${meta.recentStart}–D${meta.recentEnd}` },
    {
      id: `d${meta.previousStart}-d${meta.previousEnd}`,
      label: `D${meta.previousStart}–D${meta.previousEnd}`,
    },
    { id: `d1-d${meta.maxDay}`, label: `D1–D${meta.maxDay}` },
  ];
}

/** Compact range text for headers (avoids repeating “Selected window”). */
export function formatWindowRange(window: { label?: string | null; compareLabel?: string | null } | null | undefined) {
  const label = cleanWindowLabel(window?.label);
  const compare = cleanWindowLabel(window?.compareLabel);
  if (label && compare) return `${label} vs ${compare}`;
  return label || compare || "";
}

export function cleanWindowLabel(value: string | null | undefined) {
  if (!value) return "";
  return scrubWindowCopy(value).trim();
}

/** Strip legacy window prefixes from labels and stored proposal copy. */
export function scrubWindowCopy(value: string) {
  return value
    .replace(/Selected window\s*·\s*/gi, "")
    .replace(/Prior comparison\s*·\s*/gi, "")
    .replace(/Snapshot window\s*·\s*/gi, "")
    .replace(/Comparison window\s*·\s*/gi, "")
    .replace(/Full snapshot\s*·\s*/gi, "")
    .replace(/Recent 7 days\s*·\s*/gi, "")
    .replace(/Previous 7 days\s*·\s*/gi, "")
    .replace(/Full range\s*·\s*/gi, "")
    .replace(/近\s*7\s*天\s*·\s*/g, "")
    .replace(/前\s*7\s*天\s*·\s*/g, "")
    .replace(/全周期\s*·\s*/g, "")
    .replace(/对照\s*·\s*/g, "")
    .replace(/对照/g, "");
}

export function resolveWindow(input: string | null | undefined, meta: DatasetMeta): WindowSpec | null {
  if (!meta.ready || meta.maxDay < 1) return null;
  let start = meta.recentStart;
  let end = meta.recentEnd;
  if (input && input !== "recent_7d") {
    const match = /^d(\d+)-d(\d+)$/.exec(input);
    if (match) {
      start = Number(match[1]);
      end = Number(match[2]);
    }
  }
  if (start < 1 || end > meta.maxDay || start > end) {
    start = meta.recentStart;
    end = meta.recentEnd;
  }
  const length = end - start + 1;
  const compareEnd = start - 1;
  const compareStart = compareEnd - length + 1;
  const hasCompare = compareStart >= 1;
  const isRecent = start === meta.recentStart && end === meta.recentEnd;
  return {
    id: isRecent ? "recent_7d" : `d${start}-d${end}`,
    label: `D${start}–D${end}`,
    compareLabel: hasCompare ? `D${compareStart}–D${compareEnd}` : null,
    start,
    end,
    compareStart: hasCompare ? compareStart : null,
    compareEnd: hasCompare ? compareEnd : null,
  };
}

export function withQuery(path: string, query: Record<string, string | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

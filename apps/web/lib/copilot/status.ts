import type { RecommendationStatus } from "./types";

const CONFIRMED = new Set(["confirmed", "approved", "exported", "externally_marked"]);
const DISMISSED = new Set(["dismissed", "rejected"]);

export function normalizeDecisionStatus(status: string | null | undefined): RecommendationStatus {
  const raw = (status || "").toLowerCase();
  if (CONFIRMED.has(raw)) return "confirmed";
  if (DISMISSED.has(raw)) return "dismissed";
  return "draft";
}

export function isConfirmedStatus(status: string | null | undefined) {
  return normalizeDecisionStatus(status) === "confirmed";
}

export function isDraftStatus(status: string | null | undefined) {
  return normalizeDecisionStatus(status) === "draft";
}

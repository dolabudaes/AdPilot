import type { Ratio } from "./types";

export const DEFINITIONS = {
  passRate: "Passed cases divided by all cases. A case passes only when every declared fact, evidence, tool, and prohibited-claim check passes.",
  factualAccuracy: "Fact checks that match analysis-tool or synthetic reference values divided by all fact checks. Only facts visible in the answer or evidence fields count.",
  evidenceCoverage: "Evidence items whose IDs and metrics match the current tool citations divided by all answer evidence items.",
  unsupportedClaimRate: "Affirmative unsupported claims across the included cases and five prohibited claim categories.",
  toolExecutionReliability: "Tool calls that succeeded or returned an expected controlled error divided by attempted calls.",
  investigationLatency: "Median wall-clock time for successful local investigation-path cases. It excludes persistence, timeout, and zero-denominator checks.",
  decisionPersistenceReliability: "Proposal and decision save, read-back, and version-consistency checks. Writes are rolled back and do not alter stored product decisions.",
};

export function ratio(numerator: number, denominator: number, definition: string): Ratio {
  return { numerator, denominator, definition };
}

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function hasNumericClaim(text: string) {
  return /\d[\d,]*(?:\.\d+)?%|\d{1,3}(?:,\d{3})+/.test(text);
}

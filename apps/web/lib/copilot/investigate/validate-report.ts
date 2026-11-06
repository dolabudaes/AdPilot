import { scanUnsupportedClaims } from "@/lib/eval/claims";
import type { Citation } from "./types";
import type { LlmInvestigationDraft } from "./types";

export type ValidationIssue = { id: string; detail: string };

const CAUSAL_LANGUAGE = /caused by|root cause|due to|because of|because the|归因于|根因|导致|由于|原因是|confirmed cause/i;

export function allowedCitationIds(citations: Citation[]) {
  return new Set(citations.map((item) => item.id));
}

export function allowedNumberTokens(citations: Citation[], extraText: string) {
  const tokens = new Set<string>();
  const absorb = (value: string | null | undefined) => {
    if (!value) return;
    for (const match of value.match(/\d+(?:\.\d+)?/g) || []) tokens.add(match);
  };
  for (const cite of citations) {
    absorb(cite.value);
    absorb(cite.baseline);
    absorb(cite.absolute);
    absorb(cite.relative);
    absorb(cite.points);
  }
  for (const match of extraText.match(/\d+(?:\.\d+)?/g) || []) tokens.add(match);
  return tokens;
}

export function validateInvestigationDraft(draft: LlmInvestigationDraft, citations: Citation[], campaignId: string | string[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = allowedCitationIds(citations);
  const numbers = allowedNumberTokens(citations, "");
  const blob = JSON.stringify(draft);
  const allowedCampaigns = (Array.isArray(campaignId) ? campaignId : [campaignId]).map((item) => item.toLowerCase());

  if (scanUnsupportedClaims(blob).length) {
    issues.push({ id: "unsupported-claim", detail: "Report contains prohibited unsupported claims." });
  }

  for (const fact of draft.observedFacts || []) {
    if (!fact.text?.trim()) {
      issues.push({ id: "empty-fact", detail: "Observed fact text is empty." });
      continue;
    }
    const tier = fact.tier || "numeric";
    if (tier === "context" && fact.verified) {
      issues.push({ id: "context-marked-verified", detail: "Context statements cannot be marked verified." });
    }
    if (fact.verified && CAUSAL_LANGUAGE.test(fact.text)) {
      issues.push({ id: "verified-causal-overreach", detail: "Verified facts cannot state root causes or causal diagnosis." });
    }
    if (fact.verified) {
      const evidenceIds = fact.evidenceIds || [];
      if (!evidenceIds.length) {
        issues.push({ id: "verified-without-evidence", detail: `Verified fact missing evidence IDs: ${fact.text.slice(0, 80)}` });
      }
      for (const eid of evidenceIds) {
        if (!ids.has(eid)) issues.push({ id: "unknown-evidence-id", detail: `Unknown evidence id ${eid}` });
      }
      const nums = fact.text.match(/\d+(?:\.\d+)?/g) || [];
      for (const num of nums) {
        if (!numbers.has(num)) issues.push({ id: "ungrounded-number", detail: `Number ${num} not in tool citations` });
      }
      if (tier === "computed" && !/\%|rate|cvr|ctr|conversion|click/i.test(fact.text)) {
        issues.push({ id: "computed-tier-mismatch", detail: "Computed tier should describe a derived metric statement." });
      }
    }
    const referencedCampaigns = [...fact.text.matchAll(/campaign\s+[a-z0-9]+/gi)].map((match) => match[0].toLowerCase());
    if (referencedCampaigns.some((campaign) => !allowedCampaigns.includes(campaign))) {
      issues.push({ id: "campaign-mismatch", detail: "Fact references a different campaign than the investigation scope." });
    }
  }

  for (const eid of draft.supportingEvidenceIds || []) {
    if (!ids.has(eid)) issues.push({ id: "supporting-evidence", detail: `Supporting evidence id not in tool results: ${eid}` });
  }

  for (const hyp of draft.hypotheses || []) {
    if (!hyp.text?.trim()) issues.push({ id: "empty-hypothesis", detail: "Empty hypothesis." });
    if (hyp.unverified !== true) issues.push({ id: "hypothesis-not-marked", detail: "Hypothesis must be marked unverified." });
    if (/已经证实|verified cause|confirmed root|definitely/i.test(hyp.text)) {
      issues.push({ id: "hypothesis-too-certain", detail: "Hypothesis reads as verified fact." });
    }
  }

  return issues;
}

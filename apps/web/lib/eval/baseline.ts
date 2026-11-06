import { getCampaigns } from "@/lib/analytics";
import type { CampaignSummary } from "@/lib/analytics/types";
import { getSettings } from "@/lib/dataStore";
import { getLLMProviderFromEnv } from "@/lib/llm";
import type { LLMProvider } from "@/lib/llm/provider";
import { analyzeAttribution, getCampaignMetrics } from "@/lib/copilot/investigate/tools";
import { EVAL_CASES } from "./cases";
import { PROHIBITED_CLAIMS, scanUnsupportedClaims } from "./claims";
import { ratio } from "./metrics";
import type { Ratio } from "./types";

export type SummaryDraft = { report: string };

export function llmBaselineAvailability() {
  const settings = getSettings();
  const configured = settings.llm_provider === "openai-compatible" && settings.llm_api_key.trim().length > 0;
  return {
    configured,
    model: configured ? settings.llm_model : null,
    temperature: configured ? 0.2 : null,
    reason: configured
      ? "The summary arm and the investigation arm use the same compatible endpoint. Temperature stays at the product value of 0.2."
      : "The model comparison did not run. The provider is mock, or the API key is empty, so the summary-only arm and the tools-plus-evidence arm were not compared. No lift percentage is recorded.",
  };
}

export async function summarizeCampaign(provider: LLMProvider, summary: CampaignSummary, question: string) {
  const payload = {
    question,
    campaign: summary.display_name,
    recent: summary.recent_7d,
    previous: summary.previous_7d,
    changes: summary.changes,
  };
  return provider.generateStructured<SummaryDraft>(
    'Answer only from the supplied campaign summary. Do not call tools. Return JSON {"report":"..."}. Do not invent budget, ROAS, creative fatigue, audience age, or verified optimization outcomes.',
    JSON.stringify(payload)
  );
}

export async function runConfiguredSummaryArm() {
  const provider = getLLMProviderFromEnv();
  const campaigns = getCampaigns();
  let passed = 0;
  let total = 0;
  const caseIds: string[] = [];
  for (const spec of EVAL_CASES) {
    if (spec.kind !== "investigation" || !spec.campaignId || !spec.windowId || !spec.metric || spec.expectHandledError) continue;
    const summary = campaigns.find((item) => item.campaign_id === spec.campaignId || item.display_name === spec.campaignId);
    if (!summary || !spec.question) continue;
    const draft = await summarizeCampaign(provider, summary, spec.question);
    const report = draft.report || "";
    const reference = spec.metric === "attribution_share" ? analyzeAttribution(spec.campaignId, spec.windowId) : getCampaignMetrics(spec.campaignId, spec.windowId);
    if (!reference.ok) continue;
    const citation = reference.citations.find((item) => item.metric === spec.metric);
    if (!citation) continue;
    caseIds.push(spec.id);
    total += 1;
    if (report.includes(citation.value)) passed += 1;
    if (citation.relative) {
      total += 1;
      if (report.includes(citation.relative)) passed += 1;
    }
  }
  if (!total) throw new Error("The connected-model arm produced no scorable facts.");
  return {
    factual: ratio(passed, total, "Reference facts present in connected-model reports divided by reference facts. Only cases with explicit metrics are included."),
    caseIds,
  };
}

/** Scores a summary-only draft with the same prohibited-claim list. This is a harness check, not a model comparison. */
export function scoreSummaryDraft(report: string): { unsupported: Ratio; countsAsModelComparison: false } {
  const hits = scanUnsupportedClaims(report);
  return {
    unsupported: ratio(hits.length, PROHIBITED_CLAIMS.length, "Affirmative prohibited claims in the connected-model report divided by five prohibited categories."),
    countsAsModelComparison: false,
  };
}

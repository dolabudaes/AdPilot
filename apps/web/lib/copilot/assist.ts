import { getLLMProviderFromEnv } from "@/lib/llm";
import { isRealLlmConfigured } from "./investigate/llm-config";
import type { CopilotAnswer } from "./answers";
import { withTimeout } from "./investigate/agent";
import type { FindingView, ProductModel } from "./types";

type ModelDraft = {
  hypotheses?: unknown;
  checks?: unknown;
};

const ALLOWED = /cannot|can't|not available|unverified|hypothesis|not confirm|no budget|no roas|not in this dataset/i;

export async function assistInvestigation(model: ProductModel, question: string, draft: CopilotAnswer, finding: FindingView | null) {
  if (!finding || draft.kind !== "investigation") {
    return { answer: draft, mode: "rule" as const, note: "Rule-based analysis (no model enrichment)." };
  }
  if (!isRealLlmConfigured()) {
    return { answer: draft, mode: "rule" as const, note: "Rule-based analysis (no LLM configured)." };
  }
  try {
    const provider = getLLMProviderFromEnv();
    const facts = draft.sections.find((section) => section.title === "What We Found")?.items || [];
    const result = await withTimeout(
      provider.generateStructured<ModelDraft>(
        'Add only unverified hypotheses and verification steps in English. No new numbers. Do not state root causes or recommend execution/approval. Output JSON {"hypotheses":["..."],"checks":["..."]}. Each hypothesis must state what cannot be confirmed.',
        JSON.stringify({ question, campaign: finding.campaignName, facts, missing: model.missing })
      )
    );
    const accepted = acceptModelInvestigation(result, numberSet(draft));
    if (!accepted) return { answer: draft, mode: "rule" as const, note: "Model output failed validation; rule-based analysis retained." };
    const sections = draft.sections.map((section) => {
      if (section.title === "Possible Explanations") return { ...section, items: accepted.hypotheses };
      if (section.title === "Recommended Next Steps") return { ...section, items: accepted.checks };
      return section;
    });
    return {
      answer: { ...draft, sections },
      mode: "ai" as const,
      note: "Metrics from deterministic tools; hypotheses and checks enriched by model (validated).",
    };
  } catch {
    return { answer: draft, mode: "rule" as const, note: "Model enrichment unavailable; rule-based analysis retained." };
  }
}

export function acceptModelInvestigation(raw: ModelDraft, allowedNumbers: Set<string>) {
  const hypotheses = cleanList(raw.hypotheses);
  const checks = cleanList(raw.checks);
  if (hypotheses.length < 1 || checks.length < 1) return null;
  const lines = [...hypotheses, ...checks];
  if (lines.some((line) => !ALLOWED.test(line))) return null;
  if (lines.some((line) => /verified root cause|already executed|approved|saved \$|ROAS improved/i.test(line))) return null;
  const numbers = lines.join(" ").match(/\d+(?:\.\d+)?/g) || [];
  if (numbers.some((item) => !allowedNumbers.has(item))) return null;
  return { hypotheses: hypotheses.slice(0, 3), checks: checks.slice(0, 3) };
}

function cleanList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length >= 8 && item.length <= 180);
}

function numberSet(draft: CopilotAnswer) {
  const text = [draft.answer, ...draft.sections.flatMap((section) => section.items), ...draft.evidence.map((item) => item.value)].join(" ");
  return new Set(text.match(/\d+(?:\.\d+)?/g) || []);
}

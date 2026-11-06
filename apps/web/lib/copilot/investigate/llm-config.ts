import { getSettings } from "@/lib/dataStore";

/** OpenAI-compatible provider with a non-empty API key. */
export function isRealLlmConfigured() {
  const settings = getSettings();
  return settings.llm_provider === "openai-compatible" && settings.llm_api_key.trim().length > 0;
}

/** Paid/live model calls for evaluation (off by default). */
export function evalLiveLlmEnabled() {
  return process.env.ADPILOT_EVAL_LIVE_LLM === "1" || process.env.ADPILOT_EVAL_LIVE_LLM === "true";
}

export function evalInvestigationArm(): "rule" | "llm" {
  const raw = (process.env.ADPILOT_EVAL_INVESTIGATION_ARM || "rule").toLowerCase();
  if (raw === "llm" && evalLiveLlmEnabled() && isRealLlmConfigured()) return "llm";
  return "rule";
}

export const INVESTIGATION_WALL_CLOCK_MS = Number(process.env.ADPILOT_INVESTIGATION_TIMEOUT_MS || 90_000);
export const MAX_LLM_CALLS_PER_INVESTIGATION = Number(process.env.ADPILOT_MAX_LLM_CALLS || 8);

export class InvestigationBudget {
  readonly maxWallClockMs = INVESTIGATION_WALL_CLOCK_MS;
  readonly maxLlmCalls = MAX_LLM_CALLS_PER_INVESTIGATION;
  readonly startedAt = performance.now();
  llmCalls = 0;

  elapsedMs() {
    return Math.round(performance.now() - this.startedAt);
  }

  assertWithinWallClock() {
    if (this.elapsedMs() > this.maxWallClockMs) {
      throw new Error("investigation_timeout");
    }
  }

  assertCanCallLlm() {
    this.assertWithinWallClock();
    if (this.llmCalls >= this.maxLlmCalls) {
      throw new Error("investigation_llm_budget");
    }
  }

  recordLlmCall() {
    this.llmCalls += 1;
  }
}

export function createInvestigationBudget() {
  return new InvestigationBudget();
}

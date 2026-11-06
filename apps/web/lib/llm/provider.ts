import { AdvertisingGoal } from "../types";

export interface LLMProvider {
  generateStructured<T>(systemPrompt: string, userPrompt: string, schema?: object): Promise<T>;
}

const DEFAULT_SCHEMA_SENTINEL = "__adpilot_schema__";

export function extractJson(text: string) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error("Could not extract JSON from the response");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

export async function normalizeGoalFromProvider(rawInput: string, provider: LLMProvider) {
  const schema: AdvertisingGoal = {
    primaryGoal: "effective_conversion",
    secondaryGoals: ["Control low-quality clicks"],
    preferences: {
      prioritizeConversion: true,
      prioritizeClicks: false,
      prioritizeAttributedConversion: true,
      prioritizeCostEfficiency: true,
    },
    constraints: [],
    rawInput,
  };

  const system = `You are an advertising goal interpreter. Output must be complete JSON with no Markdown. Follow fields: ${DEFAULT_SCHEMA_SENTINEL}`;
  const result = await provider.generateStructured<AdvertisingGoal>(system, rawInput, schema);
  return result;
}

export function normalizeGoal(goal: AdvertisingGoal): AdvertisingGoal {
  const rawInput = goal.rawInput || (goal as unknown as { rawUserInput?: string }).rawUserInput || "";
  const preferences = goal.preferences || {};
  return {
    id: goal.id,
    primaryGoal: ["effective_conversion", "cost_efficiency", "traffic_growth", "risk_control", "awareness", "retention", "other"].includes(
      goal.primaryGoal || ""
    )
      ? goal.primaryGoal
      : "other",
    secondaryGoals: Array.isArray(goal.secondaryGoals) ? goal.secondaryGoals : [],
    preferences: {
      prioritizeConversion: Boolean(preferences.prioritizeConversion),
      prioritizeClicks: Boolean(preferences.prioritizeClicks),
      prioritizeAttributedConversion: Boolean(preferences.prioritizeAttributedConversion),
      prioritizeCostEfficiency: Boolean(preferences.prioritizeCostEfficiency),
      prioritizeRecentDecline: Boolean(preferences.prioritizeRecentDecline),
      prioritizeRiskControl: Boolean(preferences.prioritizeRiskControl),
    },
    constraints: Array.isArray(goal.constraints) ? goal.constraints : [],
    rawInput,
  };
}

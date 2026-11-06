import { getCampaignById, getCampaignFacts, getCampaignTrend } from "@/lib/analytics";
import { AdvertisingGoal, GuardrailResult, Strategy, StrategyAction } from "@/lib/types";

const ALLOWED_ACTIONS: StrategyAction["actionType"][] = [
  "increase_priority",
  "decrease_priority",
  "hold",
  "review",
  "pause_candidate",
];

const ANON_FIELD_TERMS = ["年龄", "性别", "地区", "地域", "收入", "商品", "行业", "品牌", "素材", "人群画像"];

function collectNumbers(value: unknown, target: number[] = []) {
  if (typeof value === "number" && Number.isFinite(value)) {
    target.push(value);
    return target;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectNumbers(item, target));
    return target;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectNumbers(item, target));
  }
  return target;
}

function closeEnough(a: number, b: number) {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
}

function textImpliesAnonymousInference(text: string) {
  const hasTerm = ANON_FIELD_TERMS.some((term) => text.includes(term));
  if (!hasTerm) return false;
  return !(text.includes("不能") || text.includes("不可") || text.includes("不解释") || text.includes("匿名"));
}

function collectText(value: unknown, target: string[] = []) {
  if (typeof value === "string") {
    target.push(value);
    return target;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, target));
    return target;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectText(item, target));
  }
  return target;
}

export function validateStrategy(strategy: Strategy, _goal?: AdvertisingGoal): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!strategy.targetCampaigns.length) {
    errors.push("Strategy does not reference any campaign.");
  }

  const actionCampaigns = new Set(strategy.actions.map((action) => action.campaignId));
  for (const campaignId of strategy.targetCampaigns) {
    const campaign = getCampaignById(campaignId);
    if (!campaign) {
      errors.push(`Strategy references a campaign that does not exist: ${campaignId}`);
      continue;
    }
    if (!actionCampaigns.has(campaignId)) {
      warnings.push(`${campaignId} is in targetCampaigns but has no matching action.`);
    }
  }

  for (const action of strategy.actions) {
    if (!ALLOWED_ACTIONS.includes(action.actionType)) {
      errors.push(`${action.campaignId} uses a disallowed actionType: ${action.actionType}`);
    }
    if (!getCampaignById(action.campaignId)) {
      errors.push(`Action references a campaign that does not exist: ${action.campaignId}`);
    }
    if (action.percentage !== undefined && action.percentage !== null) {
      warnings.push(`${action.campaignId} includes an adjustment percentage—shown only when explainable.`);
    }
  }

  for (const evidence of strategy.evidence) {
    const campaign = getCampaignById(evidence.campaignId);
    if (!campaign) {
      errors.push(`Evidence references a campaign that does not exist: ${evidence.campaignId}`);
      continue;
    }
    const facts = getCampaignFacts(evidence.campaignId);
    const trend = getCampaignTrend(evidence.campaignId);
    const allowedNumbers = [
      ...collectNumbers(campaign),
      ...collectNumbers(facts),
      ...collectNumbers(trend),
      trend.length,
    ];
    const evidenceNumbers = collectNumbers(evidence.metrics);
    for (const value of evidenceNumbers) {
      if (!allowedNumbers.some((allowed) => closeEnough(value, allowed))) {
        errors.push(`${evidence.campaignId} evidence metrics include a number Analytics cannot verify: ${value}`);
      }
    }
  }

  const text = collectText(strategy).join("\n");
  if (textImpliesAnonymousInference(text)) {
    errors.push("Proposal text must not interpret campaign labels as brand, audience, or region.");
  }

  const evidenceCount = strategy.evidence.reduce((count, item) => count + item.facts.length + Object.keys(item.metrics).length, 0);
  if (strategy.confidence > 0.9 && evidenceCount < 6) {
    errors.push("High confidence is not allowed when evidence is insufficient.");
  } else if (strategy.confidence > 0.85) {
    warnings.push("Strategy confidence is high—confirm evidence supports it.");
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}

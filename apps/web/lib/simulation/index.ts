import { getCampaigns } from "@/lib/analytics";
import { CampaignSummary, SimulationMetricSummary, SimulationResult, StrategyAction } from "@/lib/types";

export const SIMULATION_RULES = [
  "Baseline uses historical aggregate totals for the selected campaigns.",
  "increase_priority uses a 1.10 offline weight in comparisons.",
  "decrease_priority uses a 0.90 offline weight in comparisons.",
  "pause_candidate uses a 0.65 offline weight—review before pausing, not an executed pause.",
  "hold and review use a 1.00 weight.",
  "score = attributedConversions - cost * 0.001, for historical direction comparison only.",
];

function actionWeight(actionType: StrategyAction["actionType"]) {
  switch (actionType) {
    case "increase_priority":
      return 1.1;
    case "decrease_priority":
      return 0.9;
    case "pause_candidate":
      return 0.65;
    case "hold":
    case "review":
    default:
      return 1;
  }
}

function summarize(campaigns: Array<{ campaign: CampaignSummary; weight: number }>): SimulationMetricSummary {
  const totals = campaigns.reduce(
    (acc, item) => {
      acc.impressions += Math.round(item.campaign.impressions * item.weight);
      acc.clicks += Math.round(item.campaign.clicks * item.weight);
      acc.conversions += Math.round(item.campaign.conversions * item.weight);
      acc.attributedConversions += Math.round(item.campaign.attributed_conversions * item.weight);
      acc.cost += item.campaign.total_cost * item.weight;
      return acc;
    },
    { impressions: 0, clicks: 0, conversions: 0, attributedConversions: 0, cost: 0, score: 0 }
  );
  return {
    ...totals,
    cost: Number(totals.cost.toFixed(6)),
    score: Number((totals.attributedConversions - totals.cost * 0.001).toFixed(6)),
  };
}

export function simulateStrategy(actions: StrategyAction[]): SimulationResult {
  const campaigns = getCampaigns();
  const byId = new Map(campaigns.map((campaign) => [campaign.campaign_id, campaign]));
  const actionByCampaign = new Map(actions.map((action) => [action.campaignId, action]));

  const baseline = summarize(campaigns.map((campaign) => ({ campaign, weight: 1 })));
  const weightedCampaigns = campaigns.map((campaign) => {
    const action = actionByCampaign.get(campaign.campaign_id);
    return { campaign, weight: action ? actionWeight(action.actionType) : 1 };
  });
  const strategy = summarize(weightedCampaigns);

  const actionEffects = actions
    .map((action) => {
      const campaign = byId.get(action.campaignId);
      if (!campaign) return null;
      const weight = actionWeight(action.actionType);
      return {
        campaignId: action.campaignId,
        actionType: action.actionType,
        weight,
        baseline: summarize([{ campaign, weight: 1 }]),
        strategy: summarize([{ campaign, weight }]),
        note: `${action.actionType} uses offline weight ${weight.toFixed(2)}.`,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return {
    baseline,
    strategy,
    changedCampaigns: actionEffects.filter((item) => item.weight !== 1).map((item) => item.campaignId),
    actionEffects,
    rules: SIMULATION_RULES,
    note: "Strategy comparison over the current historical window.",
  };
}

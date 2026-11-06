export type ActionType = "increase_priority" | "decrease_priority" | "hold" | "review" | "pause_candidate";

export interface MetricWindow {
  impressions: number;
  clicks: number;
  conversions: number;
  attributed_conversions: number;
  total_cost: number;
  ctr: number;
  conversion_rate: number;
  attributed_conversion_rate: number;
  click_to_conversion_rate: number;
  attribution_share: number;
  cost_efficiency: number;
  start_day: number;
  end_day: number;
}

export interface CampaignSummary {
  campaign_id: string;
  display_name: string;
  raw_campaign_id: string;
  impressions: number;
  clicks: number;
  conversions: number;
  attributed_conversions: number;
  total_cost: number;
  ctr: number;
  conversion_rate: number;
  attributed_conversion_rate: number;
  click_to_conversion_rate: number;
  attribution_share: number;
  cost_efficiency: number;
  recent_7d: MetricWindow;
  previous_7d: MetricWindow;
  changes: Record<string, number | null>;
}

export interface CampaignDailyMetric {
  day: number;
  campaign_id: string;
  display_name: string;
  raw_campaign_id: string;
  impressions: number;
  clicks: number;
  conversions: number;
  attributed_conversions: number;
  total_cost: number;
  ctr: number;
  conversion_rate: number;
  attributed_conversion_rate: number;
  click_to_conversion_rate: number;
  attribution_share: number;
  cost_efficiency: number;
}

export interface CampaignFactItem {
  type: string;
  text: string;
  metrics: Record<string, number | string | null>;
}

export interface CampaignFact {
  campaign_id: string;
  display_name: string;
  raw_campaign_id: string;
  facts: CampaignFactItem[];
}

export interface GoalPreferences {
  prioritizeConversion?: boolean;
  prioritizeClicks?: boolean;
  prioritizeAttributedConversion?: boolean;
  prioritizeCostEfficiency?: boolean;
  prioritizeRecentDecline?: boolean;
  prioritizeRiskControl?: boolean;
}

export interface AdvertisingGoal {
  id?: number;
  primaryGoal: string;
  secondaryGoals: string[];
  preferences: GoalPreferences;
  constraints: string[];
  rawInput: string;
}

export interface StrategyEvidence {
  campaignId: string;
  facts: string[];
  metrics: Record<string, number | string | null>;
}

export interface StrategyAction {
  campaignId: string;
  actionType: ActionType;
  reason: string;
  percentage?: number | null;
}

export interface Strategy {
  id: number | null;
  title: string;
  summary: string;
  targetCampaigns: string[];
  evidence: StrategyEvidence[];
  actions: StrategyAction[];
  risks: string[];
  confidence: number;
}

export interface GuardrailResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

export interface SimulationMetricSummary {
  impressions: number;
  clicks: number;
  conversions: number;
  attributedConversions: number;
  cost: number;
  score: number;
}

export interface SimulationActionEffect {
  campaignId: string;
  actionType: ActionType;
  weight: number;
  baseline: SimulationMetricSummary;
  strategy: SimulationMetricSummary;
  note: string;
}

export interface SimulationResult {
  baseline: SimulationMetricSummary;
  strategy: SimulationMetricSummary;
  changedCampaigns: string[];
  actionEffects: SimulationActionEffect[];
  rules: string[];
  note: string;
}

export interface HistoryRecord {
  createdAt: string;
  rawGoal: string;
  parsedGoal: AdvertisingGoal;
  strategy: Strategy;
  userAction: "accepted" | "modified" | "rejected";
  modifiedStrategy?: Strategy | null;
  status: string;
}

export interface CampaignMetric {
  campaignId: string;
  displayName?: string;
  rawCampaignId?: string;
  impressions: number;
  clicks: number;
  conversions: number;
  attributedConversions: number;
  cost: number;
  ctr: number;
  conversionRate: number;
  attributedConversionRate: number;
  clickToConversionRate?: number;
  costEfficiency: number;
}

export type ActionItem = StrategyAction;
export type SimulationOutput = SimulationResult;

export interface Insight {
  id: string;
  campaignId: string;
  type: string;
  title: string;
  description: string;
  evidence: string;
  relevanceToGoal: string;
  confidence: number;
}

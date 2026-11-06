import type { ToolName } from "@/lib/copilot/investigate/types";

export type DemoTurnSpec = {
  id: string;
  userQuestion: string;
  resolvedScope: "campaign" | "account" | "comparison";
  requiredMetrics: string[];
  analysisOperation: string;
  requiredTools: ToolName[];
  expectedFacts: string[];
  expectedBehavior: string;
  unsupportedClaims: string[];
  expectedNextStep: string;
  windowId?: string;
  reviewReady?: boolean;
};

export type DemoInvestigationSpec = {
  id: string;
  title: string;
  campaignId: string | null;
  selectedWindow: string;
  turns: DemoTurnSpec[];
};

const NEVER_CLAIM = ["increased budget", "bid change caused", "creative caused", "ROAS improved", "platform-verified execution"];

export const DEMO_INVESTIGATIONS: DemoInvestigationSpec[] = [
  {
    id: "demo-campaign-r-multiturn-v6",
    title: "Campaign R multi-turn investigation",
    campaignId: "Campaign R",
    selectedWindow: "d25-d31",
    turns: [
      {
        id: "r-1",
        userQuestion: "Why is Campaign R flagged as high priority?",
        resolvedScope: "campaign",
        requiredMetrics: ["clicks", "conversion_linked_clicks", "post_click_conversion_link_rate"],
        analysisOperation: "compare_periods",
        requiredTools: ["get_campaign_metrics"],
        expectedFacts: ["high priority", "7\\.66%", "5\\.25%", "decline of 2\\.41 percentage points", "not a count of unique conversion events"],
        expectedBehavior: "Explain the high-priority flag from verified conversion-link evidence, not an unverified cause.",
        unsupportedClaims: NEVER_CLAIM,
        expectedNextStep: "Inspect whether the decline was sustained or concentrated.",
      },
      {
        id: "r-2",
        userQuestion: "Was the decline sustained, or concentrated on a few dates?",
        resolvedScope: "campaign",
        requiredMetrics: ["daily_clicks", "daily_conversion_linked_clicks"],
        analysisOperation: "daily_trend",
        requiredTools: ["analyze_daily_trend", "get_campaign_metrics"],
        expectedFacts: ["days were above the prior-window aggregate", "top day.*accounted"],
        expectedBehavior: "Use real D-label daily rows and distinguish persistence from concentration.",
        unsupportedClaims: NEVER_CLAIM,
        expectedNextStep: "Compare Campaign D in the same window.",
      },
      {
        id: "r-3",
        userQuestion: "How did Campaign D perform in the same window?",
        resolvedScope: "comparison",
        requiredMetrics: ["post_click_conversion_link_rate", "relative_change"],
        analysisOperation: "compare_campaigns",
        requiredTools: ["compare_campaigns"],
        expectedFacts: ["Campaign R", "Campaign D", "percentage points", "opposite directions|same direction"],
        expectedBehavior: "Treat Campaign D as a comparison object and avoid inferring a shared cause.",
        unsupportedClaims: NEVER_CLAIM,
        expectedNextStep: "Test whether a creative change could explain both declines.",
      },
      {
        id: "r-4",
        userQuestion: "Could a creative change have caused both Campaign R and Campaign D to decline?",
        resolvedScope: "comparison",
        requiredMetrics: ["post_click_conversion_link_rate"],
        analysisOperation: "missing_evidence_check",
        requiredTools: ["compare_campaigns", "get_campaign_metrics"],
        expectedFacts: ["cannot be verified", "no creative-level fields|no creative", "Campaign R", "Campaign D"],
        expectedBehavior: "Keep creative as an unverified hypothesis while reusing the same-window comparison.",
        unsupportedClaims: ["creative (?:caused|drove|reduced)", ...NEVER_CLAIM],
        expectedNextStep: "Decide which campaign to review first.",
      },
      {
        id: "r-5",
        userQuestion: "Which campaign should we review first, and what should we verify?",
        resolvedScope: "account",
        requiredMetrics: ["severity", "post_click_conversion_link_rate"],
        analysisOperation: "prioritize_review",
        requiredTools: ["compare_campaigns"],
        expectedFacts: ["Campaign R", "first human review", "high", "does not authorize a delivery change"],
        expectedBehavior: "Prioritize Campaign R from verified severity and list what still needs human verification.",
        unsupportedClaims: NEVER_CLAIM,
        expectedNextStep: "Compile the investigation into a decision draft.",
      },
      {
        id: "r-6",
        userQuestion: "Compile all prior investigation evidence into one human-review recommendation and create a Decision Draft.",
        resolvedScope: "campaign",
        requiredMetrics: ["post_click_conversion_link_rate", "evidence_ids"],
        analysisOperation: "decision_brief",
        requiredTools: ["get_campaign_metrics", "retrieve_decision_history"],
        expectedFacts: ["compiles evidence from", "manual review", "human-reviewed decision", "does not execute", "Decision Draft"],
        expectedBehavior: "Synthesize every prior turn, not only the last question, and leave confirmation to the user.",
        unsupportedClaims: ["automatically pause", "increase budget", ...NEVER_CLAIM],
        expectedNextStep: "Create a proposal only after explicit user action.",
        reviewReady: true,
      },
    ],
  },
  {
    id: "demo-campaign-q-premise-v6",
    title: "Campaign Q premise correction and window switching",
    campaignId: "Campaign Q",
    selectedWindow: "recent_7d",
    turns: [
      {
        id: "q-1",
        userQuestion: "Why did Campaign Q decline?",
        resolvedScope: "campaign",
        requiredMetrics: ["clicks", "conversion_linked_clicks", "post_click_conversion_link_rate"],
        analysisOperation: "compare_periods",
        requiredTools: ["get_campaign_metrics", "retrieve_decision_history"],
        expectedFacts: ["Campaign Q", "percentage points", "not a count of unique conversion events"],
        expectedBehavior: "Answer against the currently selected window without inventing a later historical window.",
        unsupportedClaims: NEVER_CLAIM,
        expectedNextStep: "Clarify whether the user meant an earlier window.",
      },
      {
        id: "q-2",
        userQuestion: "I meant the earlier D18–D24 window. Please re-check Campaign Q there and explain what actually happened.",
        resolvedScope: "campaign",
        requiredMetrics: ["clicks", "conversion_linked_clicks", "post_click_conversion_link_rate"],
        analysisOperation: "premise_check_and_compare_periods",
        requiredTools: ["get_campaign_metrics"],
        expectedFacts: ["Re-checked", "premise is not supported", "31\\.84%", "43\\.90%", "increase of 12\\.06 percentage points"],
        expectedBehavior: "Switch analysis to D18–D24, correct the decline premise, and keep the conversation pin unchanged.",
        unsupportedClaims: NEVER_CLAIM,
        expectedNextStep: "Ask whether budget should increase.",
        windowId: "recent_7d",
      },
      {
        id: "q-3",
        userQuestion: "Should we increase Campaign Q's budget now?",
        resolvedScope: "campaign",
        requiredMetrics: ["post_click_conversion_link_rate"],
        analysisOperation: "decision_safety_check",
        requiredTools: ["get_campaign_metrics"],
        expectedFacts: ["cannot be verified|no budget", "does not prove|cannot confirm|not establish", "Validate"],
        expectedBehavior: "Refuse to treat a conversion-link improvement as proof that more budget would work, and recommend human validation.",
        unsupportedClaims: ["increase (?:the )?budget", "scale now", ...NEVER_CLAIM],
        expectedNextStep: "Validate observed efficiency improvement without changing delivery.",
      },
    ],
  },
];

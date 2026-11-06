import { getLLMProviderFromEnv } from "@/lib/llm";
import { isRealLlmConfigured } from "./llm-config";
import type { FindingView } from "../types";
import {
  analyzeAttribution,
  analyzeDailyTrend,
  compareCampaigns,
  detectAnomalousDays,
  getCampaignMetrics,
  retrieveDecisionHistory,
} from "./tools";
import type { InvestigationStep, ToolName, ToolResult } from "./types";

const MAX_CALLS = 6;
export const TOOL_TIMEOUT_MS = 12000;

export function withTimeout<T>(work: Promise<T>, timeoutMs = TOOL_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
}

const TOOL_LABEL: Record<ToolName, string> = {
  get_campaign_metrics: "Campaign window metrics",
  analyze_daily_trend: "Daily trend analysis",
  compare_campaigns: "Campaign comparison",
  analyze_attribution: "Attribution metrics",
  detect_anomalous_days: "Anomaly day detection",
  retrieve_decision_history: "Decision history",
};

const STATUS_LABEL: Record<ToolName, string> = {
  get_campaign_metrics: "Analyzing campaign performance…",
  analyze_daily_trend: "Comparing daily trends…",
  compare_campaigns: "Checking other campaigns…",
  analyze_attribution: "Reviewing attribution metrics…",
  detect_anomalous_days: "Scanning daily anomalies…",
  retrieve_decision_history: "Loading findings and decisions…",
};

export type AgentRun = {
  results: ToolResult[];
  steps: InvestigationStep[];
  mode: "agent" | "rule";
  statusTrail: string[];
  toolSelection: "llm" | "rule" | "llm_fallback";
  toolSelectionErrors: string[];
};

type AgentContext = {
  question: string;
  accountId: string;
  windowId: string;
  campaignId: string;
  scope: "account" | "campaign" | "comparison";
  scopedCampaignIds: string[];
  findingId: string | null;
  finding: FindingView | null;
  peerCampaignIds: string[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
};

type ToolCall = { tool: ToolName; campaignIds?: string[]; span?: "both" | "current" | "all" };

export function statusForTool(tool: ToolName) {
  return STATUS_LABEL[tool];
}

export async function runInvestigationAgent(
  ctx: AgentContext,
  options: { forceRuleTools?: boolean; budget?: import("./llm-config").InvestigationBudget } = {}
): Promise<AgentRun> {
  const results: ToolResult[] = [];
  const steps: InvestigationStep[] = [];
  const statusTrail: string[] = [];
  const called = new Set<ToolName>();
  const toolSelectionErrors: string[] = [];
  let mode: "agent" | "rule" = "rule";
  let llmPicks = 0;
  let rulePicksAfterLlmConfigured = 0;
  const llmConfigured = isRealLlmConfigured() && !options.forceRuleTools;

  for (let round = 0; round < MAX_CALLS; round += 1) {
    const next = await pickNextTool(ctx, results, called, round === 0, {
      forceRuleTools: options.forceRuleTools,
      toolSelectionErrors,
      budget: options.budget,
    });
    if (!next) break;
    if (called.has(next.tool)) break;
    called.add(next.tool);
    statusTrail.push(STATUS_LABEL[next.tool]);
    const result = executeTool(next, ctx);
    results.push(result);
    steps.push({
      tool: next.tool,
      label: TOOL_LABEL[next.tool],
      ok: result.ok,
      summary: result.ok ? summarizeTool(result) : result.message,
      picker: next.source === "agent" ? "llm" : "rule",
    });
    if (!result.ok && blockingFailure(next.tool)) break;
    if (shouldStopAfter(ctx.question, results, ctx.scope)) break;
    mode = next.source === "agent" ? "agent" : mode;
    if (next.source === "agent") llmPicks += 1;
    else if (llmConfigured) rulePicksAfterLlmConfigured += 1;
  }

  const toolSelection =
    llmPicks > 0 ? "llm" : llmConfigured && rulePicksAfterLlmConfigured > 0 ? "llm_fallback" : "rule";

  return { results, steps, mode: llmPicks > 0 ? "agent" : "rule", statusTrail, toolSelection, toolSelectionErrors };
}

function blockingFailure(tool: ToolName) {
  return tool === "get_campaign_metrics" || tool === "compare_campaigns";
}

function shouldStopAfter(question: string, results: ToolResult[], scope?: AgentContext["scope"]) {
  const q = question.toLowerCase();
  const hasCompare = results.some((item) => item.ok && item.tool === "compare_campaigns");
  const hasMetrics = results.some((item) => item.ok && item.tool === "get_campaign_metrics");
  if (/creative|素材|budget|预算/.test(q) && hasCompare && !hasMetrics) return false;
  if (scope === "account" || scope === "comparison") return hasCompare;
  if (/other campaign|同样|same pattern|campaign d|相比/.test(q)) return true;
  if (/particular day|哪一天|daily|趋势|trend/.test(q)) return results.length >= 2;
  return results.length >= 2;
}

function executeTool(call: ToolCall, ctx: AgentContext): ToolResult {
  const scope = ctx.finding?.windowId || ctx.windowId;
  switch (call.tool) {
    case "get_campaign_metrics":
      return getCampaignMetrics(ctx.campaignId, scope);
    case "analyze_daily_trend":
      return analyzeDailyTrend(ctx.campaignId, scope, call.span || "both");
    case "compare_campaigns": {
      const ids = normalizeCampaignIds(
        call.campaignIds?.length
          ? call.campaignIds
          : ctx.scopedCampaignIds.length > 1
            ? ctx.scopedCampaignIds
            : [ctx.campaignId, ...mentionedPeers(ctx.question), ...ctx.peerCampaignIds.slice(0, 2)]
      );
      return compareCampaigns(ids, scope);
    }
    case "analyze_attribution":
      return analyzeAttribution(ctx.campaignId, scope);
    case "detect_anomalous_days":
      return detectAnomalousDays(ctx.campaignId, scope);
    case "retrieve_decision_history":
      return retrieveDecisionHistory(ctx.accountId, scope, ctx.findingId, ctx.campaignId);
    default:
      return { ok: false, tool: "get_campaign_metrics", message: "The requested tool is not allowlisted." };
  }
}

async function pickNextTool(
  ctx: AgentContext,
  results: ToolResult[],
  called: Set<ToolName>,
  first: boolean,
  options: { forceRuleTools?: boolean; toolSelectionErrors: string[]; budget?: import("./llm-config").InvestigationBudget }
): Promise<(ToolCall & { source: "agent" | "rule" }) | null> {
  const canAgent = isRealLlmConfigured() && !options.forceRuleTools;
  if (canAgent) {
    try {
      options.budget?.assertCanCallLlm();
      const llm = await llmPickTool(ctx, results, called, options.budget);
      options.budget?.recordLlmCall();
      if (llm === null) return null;
      if (llm && !called.has(llm.tool)) return { ...llm, source: "agent" };
    } catch (error) {
      options.toolSelectionErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const rule = rulePickTool(ctx, results, called, first);
  if (!rule || called.has(rule.tool)) return null;
  return { ...rule, source: "rule" };
}

async function llmPickTool(
  ctx: AgentContext,
  results: ToolResult[],
  called: Set<ToolName>,
  _budget?: import("./llm-config").InvestigationBudget
): Promise<ToolCall | null | false> {
  const provider = getLLMProviderFromEnv();
  const allTools: ToolName[] = [
    "get_campaign_metrics",
    "analyze_daily_trend",
    "compare_campaigns",
    "analyze_attribution",
    "detect_anomalous_days",
    "retrieve_decision_history",
  ];
  const tools = allTools.filter((item) => !called.has(item));
  if (!tools.length) return null;
  const payload = {
    question: ctx.question,
    campaignId: ctx.campaignId,
    analysisScope: ctx.scope,
    scopedCampaignIds: ctx.scopedCampaignIds,
    findingId: ctx.findingId,
    alreadyCalled: [...called],
    priorSummaries: results.map((item) => (item.ok ? summarizeTool(item) : item.message)),
    recentConversation: ctx.history.slice(-6),
    allowedTools: tools,
  };
  const system =
    'You are an advertising investigation agent. Select exactly one next tool or stop. Return JSON {"action":"call"|"stop","tool":"...","campaignIds":["Campaign X"],"span":"both"|"current"|"all"}. Never claim or recommend that an advertising-platform change has been executed.';
  const raw = await withTimeout(
    provider.generateStructured<{ action: string; tool?: ToolName; campaignIds?: string[]; span?: "both" | "current" | "all" }>(system, JSON.stringify(payload))
  );
  if (raw.action === "stop" || !raw.tool) return null;
  if (!tools.includes(raw.tool)) return false;
  const campaignIds = raw.campaignIds ? normalizeCampaignIds(raw.campaignIds) : undefined;
  return { tool: raw.tool, campaignIds, span: raw.span === "current" || raw.span === "all" ? raw.span : "both" };
}

/** Dedupe campaign labels only — unknown IDs must reach tools so validation errors stay faithful. */
export function normalizeCampaignIds(ids: string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export function rulePickTool(ctx: AgentContext, results: ToolResult[], called: Set<ToolName>, first: boolean): ToolCall | null {
  const q = ctx.question.toLowerCase();
  const peers = mentionedPeers(ctx.question).filter((item) => item.toLowerCase() !== ctx.campaignId.toLowerCase());

  if (/which campaign should|review first|prioriti[sz]e first|first human review/.test(q)) {
    if (!called.has("compare_campaigns")) return { tool: "compare_campaigns", campaignIds: ctx.scopedCampaignIds };
    return null;
  }
  if (/high priority|flagged as high|re-?check|i meant|actually happened/.test(q) && !/daily|sustained|concentrated|few dates|few days|trend/.test(q)) {
    if (!called.has("get_campaign_metrics")) return { tool: "get_campaign_metrics" };
    return null;
  }

  if ((ctx.scope === "account" || ctx.scope === "comparison") && !called.has("compare_campaigns")) {
    return { tool: "compare_campaigns", campaignIds: ctx.scopedCampaignIds };
  }

  if (/原建议|已导出|审批|proposal|导出|decision history|决策历史/.test(q) && !called.has("retrieve_decision_history")) {
    return { tool: "retrieve_decision_history" };
  }
  if (/归因|attribution|attributed/.test(q) && !called.has("analyze_attribution")) {
    return { tool: "analyze_attribution" };
  }
  if (/worst day|异常日|anomal|哪一天|particular day|outlier|spike|drop day/.test(q) && !called.has("detect_anomalous_days")) {
    return { tool: "detect_anomalous_days" };
  }
  if (/异常日|anomal|哪一天|particular day|daily|趋势|trend|按日|sustained|concentrated|few days|few dates/.test(q) && !called.has("analyze_daily_trend")) {
    return { tool: "analyze_daily_trend", span: "both" };
  }
  if ((peers.length || /other campaign|同样|same pattern|isolated|worse|better/.test(q)) && !called.has("compare_campaigns")) {
    return { tool: "compare_campaigns", campaignIds: peers.length ? [ctx.campaignId, ...peers] : undefined };
  }
  if (/异常|outlier|spike|drop day/.test(q) && !called.has("detect_anomalous_days")) {
    return { tool: "detect_anomalous_days" };
  }
  if (/素材|creative|落地页|受众|audience|budget|预算|roas|landing|spend|fatigue/.test(q)) {
    if ((peers.length || /both campaigns|campaign r.*campaign d|campaign d.*campaign r/.test(q)) && !called.has("compare_campaigns")) {
      return { tool: "compare_campaigns", campaignIds: peers.length ? [ctx.campaignId, ...peers] : undefined };
    }
    if (!called.has("get_campaign_metrics")) return { tool: "get_campaign_metrics" };
    return null;
  }
  if (/recommend(?:ation)?|what action|which action|next action|proposal|create decision|compil(?:e|ed)|decision draft/.test(q)) {
    if (!called.has("get_campaign_metrics")) return { tool: "get_campaign_metrics" };
    if (ctx.findingId && !called.has("retrieve_decision_history")) return { tool: "retrieve_decision_history" };
    return null;
  }
  if (/下一步|investigate next|what should|verify next|核验|verify/.test(q)) {
    if (ctx.findingId && !called.has("retrieve_decision_history")) return { tool: "retrieve_decision_history" };
    if (!called.has("analyze_daily_trend")) return { tool: "analyze_daily_trend", span: "both" };
    if (!called.has("get_campaign_metrics")) return { tool: "get_campaign_metrics" };
    return null;
  }
  if (first && !called.has("get_campaign_metrics") && /why|为什么|decline|下降|cvr|转化率|efficiency/.test(q)) {
    return { tool: "get_campaign_metrics" };
  }
  if (!called.has("get_campaign_metrics") && first) {
    return { tool: "get_campaign_metrics" };
  }
  if (/why|为什么|decline|下降|efficiency/.test(q)) {
    if (!called.has("get_campaign_metrics")) return { tool: "get_campaign_metrics" };
    if (ctx.findingId && !called.has("retrieve_decision_history")) return { tool: "retrieve_decision_history" };
    if (!called.has("analyze_daily_trend")) return { tool: "analyze_daily_trend", span: "both" };
    return null;
  }
  if (!called.has("get_campaign_metrics") && called.has("analyze_daily_trend")) {
    return { tool: "get_campaign_metrics" };
  }
  return null;
}

function mentionedPeers(question: string) {
  return [...question.matchAll(/campaign\s+([a-z0-9]+)/gi)].map((item) => `Campaign ${item[1].toUpperCase()}`);
}

function summarizeTool(result: ToolResult) {
  if (!result.ok) return result.message;
  switch (result.tool) {
    case "get_campaign_metrics":
      return `${result.campaignName} window metrics for ${result.windowLabel}`;
    case "analyze_daily_trend":
      return `${result.campaignName} daily trend across ${result.points.length} days`;
    case "compare_campaigns":
      return `${result.rows.length} campaigns compared`;
    case "analyze_attribution":
      return `${result.campaignName} attribution share ${result.attributionShare ?? "n/a"}`;
    case "detect_anomalous_days":
      return `${result.days.filter((d) => d.notable).length} notable days`;
    case "retrieve_decision_history":
      return `${result.entries.length} history records`;
  }
  return "completed";
}

export function toolPlanForQuestion(question: string, ctx: AgentContext) {
  const called = new Set<ToolName>();
  const planned: ToolCall[] = [];
  const simulated: ToolResult[] = [];
  for (let i = 0; i < MAX_CALLS; i += 1) {
    const next = rulePickTool(ctx, simulated, called, i === 0);
    if (!next || called.has(next.tool)) break;
    called.add(next.tool);
    planned.push(next);
    simulated.push({ ok: true, tool: next.tool } as ToolResult);
  }
  return planned;
}

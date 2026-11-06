import { getDatasetMeta } from "@/lib/analytics";
import { answerQuestion, type CopilotAnswer } from "@/lib/copilot/answers";
import { assistInvestigation } from "@/lib/copilot/assist";
import { FINDING_LABEL } from "@/lib/copilot/labels";
import { buildProductModel } from "@/lib/copilot/service";
import type { FindingView, ProductModel, TrendPoint } from "@/lib/copilot/types";
import { runInvestigationAgent, toolPlanForQuestion as planTools, type AgentRun } from "./agent";
import { narrateInvestigation } from "./narrate";
import { isCompileQuestion, resolveTurnWindow } from "./window-resolve";
import { createInvestigationBudget, isRealLlmConfigured } from "./llm-config";
import { applySynthesisToInvestigation, sectionsFromInvestigation, synthesizeInvestigationReport } from "./synthesis";
import type { Citation, InvestigationResultPayload, InvestigationRuntimeTrace, InvestigationStep, ToolName, ToolResult } from "./types";

export type InvestigationAnswer = CopilotAnswer & {
  series: TrendPoint[] | null;
  tools: ToolName[];
  steps: InvestigationStep[];
  statusTrail: string[];
  investigation: InvestigationResultPayload | null;
  runtime: InvestigationRuntimeTrace | null;
};

export async function investigateTurn(input: {
  question: string;
  accountId: string;
  windowId: string;
  campaignId: string | null;
  findingId: string | null;
  forceRuleMode?: boolean;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ answer: InvestigationAnswer; mode: "rule" | "ai" | "agent" | "llm" | "llm_partial"; note: string }> {
  const pinnedWindowId = input.windowId;
  const windowId = resolveTurnWindow(input.question, input.history, pinnedWindowId);
  const invalidWindow = invalidRequestedWindow(windowId);
  if (invalidWindow) {
    return {
      answer: bare(invalidWindow, "chat", [], null, [], [], null),
      mode: "rule",
      note: "Requested window is outside the imported dataset; no analysis tools were run.",
    };
  }
  const pinnedModel = windowId === pinnedWindowId ? null : buildProductModel({ accountId: input.accountId, windowId: pinnedWindowId });
  const model = buildProductModel({ accountId: input.accountId, windowId });
  const windowSwitched = windowId !== pinnedWindowId;
  const boundFinding = model.findings.find((item) => item.id === input.findingId) || null;

  if (isGreeting(input.question)) {
    return {
      answer: bare(
        "Hi — I can help you inspect campaign performance, compare campaigns, or trace a change across the selected and prior windows. What would you like to look into?",
        "chat",
        [],
        null,
        [],
        [],
        null
      ),
      mode: "rule",
      note: "Conversational reply; no campaign analysis was run.",
    };
  }

  const requestedCampaigns = mentioned(input.question).filter((id) => !isFalseCampaignMention(id));
  const availableCampaigns = new Set(model.campaigns.map((item) => item.id));
  const missingCampaign = requestedCampaigns.find((id) => !availableCampaigns.has(id));
  if (missingCampaign) {
    const examples = model.campaigns.slice(0, 4).map((item) => item.name).join(", ");
    return {
      answer: bare(`${missingCampaign} is not in this account. Try an available campaign such as ${examples}, or ask an account-wide question.`, "chat", [], null, [], [], null),
      mode: "rule",
      note: "Unknown campaign; no analysis tools were run.",
    };
  }

  const scope = resolveAnalysisScope(input.question, input.campaignId || boundFinding?.campaignId || null, model);
  const campaignId = scope.primaryCampaignId;
  const finding = campaignId ? model.findings.find((item) => item.campaignId === campaignId) || null : null;
  const investigable = scope.kind === "account" || Boolean(campaignId || /campaign\s+[a-z0-9]/i.test(input.question));

  if (!investigable) {
    const draft = answerQuestion(model, input.question, input.findingId);
    const assisted = await assistInvestigation(model, input.question, draft, finding);
    return {
      answer: { ...assisted.answer, series: null, tools: [], steps: [], statusTrail: [], investigation: null, runtime: null },
      mode: assisted.mode,
      note: assisted.note,
    };
  }

  const primary = campaignId || mentioned(input.question)[0];
  if (!primary) {
    const answer = bare("Bind a campaign investigation or include a campaign name in your question.", "chat", [], null, [], [], null);
    return { answer, mode: "rule", note: "No investigable campaign." };
  }

  const peerCampaignIds = model.campaigns.map((item) => item.id).filter((id) => id !== primary);
  const budget = createInvestigationBudget();
  const forceRule = input.forceRuleMode || !isRealLlmConfigured();
  let agentRun;
  try {
    budget.assertWithinWallClock();
    agentRun = await runInvestigationAgent(
      {
        question: input.question,
        accountId: input.accountId,
        windowId,
        campaignId: primary,
        scope: scope.kind,
        scopedCampaignIds: scope.campaignIds,
        findingId: finding?.id || null,
        finding,
        peerCampaignIds,
        history: input.history || [],
      },
      { forceRuleTools: forceRule, budget }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const answer = bare(`Investigation stopped: ${message}.`, "chat", [], null, [], [], null);
    return {
      answer: {
        ...answer,
        runtime: {
          investigationMode: "rule",
          toolSelection: "rule",
          reportSynthesis: "skipped",
          toolSelectionErrors: [message],
          synthesisErrors: [],
          validationIssueCount: 0,
          fallbackLabel: "Fallback to Rule-based Mode (investigation budget)",
          llmCallCount: budget.llmCalls,
          fallbackCount: 1,
          elapsedMs: budget.elapsedMs(),
        },
      },
      mode: "rule",
      note: `Investigation budget exceeded (${message}). Fallback to Rule-based Mode.`,
    };
  }

  const failed = agentRun.results.find((item) => !item.ok);
  if (failed && !failed.ok && agentRun.results.length === 1) {
    const answer = bare(`${failed.message} No other data was used to replace this result.`, "chat", [], null, agentRun.steps, agentRun.statusTrail, null);
    return {
      answer: {
        ...answer,
        runtime: traceFromAgent(agentRun, budget, "rule", "skipped", 0, agentRun.toolSelection === "llm_fallback" ? 1 : 0),
      },
      mode: "rule",
      note: "Tool query did not complete. No model rewrite was applied.",
    };
  }

  const narrated = narrateInvestigation(input.question, agentRun.results, finding, input.history);
  const switchedLead = windowSwitched
    ? `Re-checked ${model.window?.label || windowId} as requested (the conversation remains pinned to ${pinnedModel?.window?.label || pinnedWindowId}). `
    : "";
  let answer = {
    ...bare(`${switchedLead}${narrated.answer}`, narrated.kind, collectCitations(agentRun.results), narrated.series, agentRun.steps, agentRun.statusTrail, narrated.investigation),
    sections: narrated.sections,
  };
  const tools = agentRun.results.filter((item) => item.ok).map((item) => item.tool);
  const toolText = tools.join(", ");
  const citations = collectCitations(agentRun.results);
  const windowLabel = finding?.windowLabel || model.window?.label || windowId;

  let runtime: InvestigationRuntimeTrace = traceFromAgent(agentRun, budget, "rule", "skipped", 0, agentRun.toolSelection === "llm_fallback" ? 1 : 0);

  let mode: "rule" | "ai" | "agent" | "llm" | "llm_partial" = forceRule ? "rule" : agentRun.mode === "agent" ? "agent" : "rule";
  let note = forceRule
    ? `Rule-based investigation (LLM not used): ${toolText}. Metrics from campaign_daily.csv.`
    : agentRun.toolSelection === "llm"
      ? `Real LLM investigation: ${toolText}. Tools selected by the model; metrics from processed data.`
      : `Fallback to Rule-based Mode (tool selection). Tools run: ${toolText}.`;

  if (!forceRule && isRealLlmConfigured() && agentRun.results.some((item) => item.ok)) {
    const synthesis = await synthesizeInvestigationReport({
      question: input.question,
      history: input.history || [],
      campaignId: primary,
      campaignIds: scope.campaignIds,
      analysisScope: scope.kind,
      windowLabel,
      agentRun,
      citations,
      toolResults: agentRun.results,
      budget,
    });
    runtime.validationIssueCount = synthesis.issues.length;
    if (synthesis.error) runtime.synthesisErrors.push(synthesis.error);
    if (synthesis.status === "verified" && synthesis.draft) {
      const investigation = applySynthesisToInvestigation(answer.investigation || { found: [], explanations: [], cannotDetermine: [], nextSteps: [] }, synthesis);
      answer = {
        ...answer,
        answer: synthesis.draft.summary,
        investigation,
        sections: sectionsFromInvestigation(investigation),
        kind: "investigation",
      };
      runtime.investigationMode = "llm";
      runtime.reportSynthesis = "llm_verified";
      mode = "llm";
      note = `Real LLM investigation with evidence validation. Tools: ${toolText}.`;
    } else if (synthesis.status === "partial" && synthesis.draft) {
      const investigation = applySynthesisToInvestigation(answer.investigation || { found: [], explanations: [], cannotDetermine: [], nextSteps: [] }, synthesis);
      answer = {
        ...answer,
        answer: `${synthesis.draft.summary} (Partial LLM report — some facts did not pass validation.)`,
        investigation,
        sections: sectionsFromInvestigation(investigation),
      };
      runtime.investigationMode = "llm_partial";
      runtime.reportSynthesis = "llm_partial";
      mode = "llm_partial";
      note = `Partial LLM investigation. Validation issues: ${synthesis.issues.length}. Rule-based facts retained where needed.`;
    } else {
      runtime.reportSynthesis = "rule_template";
      runtime.synthesisErrors.push("LLM report synthesis failed or was rejected.");
      runtime.fallbackCount += 1;
      runtime.fallbackLabel = runtime.fallbackLabel || "Fallback to Rule-based Mode (report synthesis)";
      note = `${note} Fallback to Rule-based Mode (report synthesis).`;
    }
  } else {
    runtime.reportSynthesis = "rule_template";
  }

  runtime.llmCallCount = budget.llmCalls;
  runtime.elapsedMs = budget.elapsedMs();

  const useAssist = !forceRule && mode === "rule" && answer.kind === "investigation";
  const assisted = useAssist ? await assistInvestigation(model, input.question, answer, finding) : { answer, mode: mode === "llm" || mode === "llm_partial" ? mode : (mode as "rule" | "agent"), note: "" };
  if (assisted.mode === "ai" && mode === "rule") {
    mode = "ai";
    note = assisted.note || note;
  }

  const compileReady = isCompileQuestion(input.question);
  return {
    answer: {
      ...assisted.answer,
      series: answer.series,
      tools,
      steps: agentRun.steps,
      statusTrail: agentRun.statusTrail,
      investigation: answer.investigation,
      runtime,
      reviewReady: compileReady || assisted.answer.reviewReady,
      kind: compileReady ? "review" : assisted.answer.kind,
    },
    mode,
    note: assisted.note && mode === "ai" ? assisted.note : note,
  };
}

function invalidRequestedWindow(windowId: string) {
  const match = /^d(\d+)-d(\d+)$/.exec(windowId);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const maxDay = getDatasetMeta().maxDay;
  if (start >= 1 && end >= start && end <= maxDay) return null;
  return `Requested window D${start}–D${end} is outside the imported relative-day coverage D1–D${maxDay}. Choose a window within D1–D${maxDay}; no fallback window was analyzed.`;
}

function isGreeting(question: string) {
  return /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|adpilot))?[.!?\s]*$/i.test(question.trim());
}

type AnalysisScope = {
  kind: "account" | "campaign" | "comparison";
  primaryCampaignId: string | null;
  campaignIds: string[];
};

function resolveAnalysisScope(question: string, boundCampaignId: string | null, model: ProductModel): AnalysisScope {
  const q = question.toLowerCase();
  const allCampaignIds = model.campaigns.map((item) => item.id);
  const flaggedCampaignIds = model.findings.map((item) => item.campaignId);
  const mentions = mentioned(question).filter((id) => allCampaignIds.includes(id));
  const accountWide = /which campaign(?:s)?|campaigns (?:need|require|deserve) attention|all (?:flagged )?campaigns|across (?:the )?(?:account|portfolio|project)|account[- ]wide|portfolio[- ]wide|project[- ]wide|overall (?:account|project)/.test(q);
  const comparisonIntent = /compare|versus|\bvs\b|other campaign|same pattern|what about|how about|is campaign [a-z0-9]+ (?:showing|the same|worse|better)|how (?:did|does) campaign|worse|better|相比|同样/.test(q);

  // Explicitly named campaigns constrain a comparison even when the user says
  // "account-wide" to distinguish it from the conversation's bound campaign.
  if (mentions.length > 1 && comparisonIntent) {
    return { kind: "comparison", primaryCampaignId: mentions[0], campaignIds: [...new Set(mentions)] };
  }

  if (accountWide) {
    const ids = flaggedCampaignIds.length ? flaggedCampaignIds : allCampaignIds;
    return { kind: "account", primaryCampaignId: ids[0] || boundCampaignId, campaignIds: ids };
  }

  if (mentions.length > 1 || (mentions.length === 1 && boundCampaignId && mentions[0] !== boundCampaignId && comparisonIntent)) {
    const ids = [...new Set([...(boundCampaignId ? [boundCampaignId] : []), ...mentions])];
    return { kind: "comparison", primaryCampaignId: mentions[0] || boundCampaignId, campaignIds: ids };
  }
  if (mentions.length === 1) return { kind: "campaign", primaryCampaignId: mentions[0], campaignIds: mentions };
  if (boundCampaignId) return { kind: "campaign", primaryCampaignId: boundCampaignId, campaignIds: [boundCampaignId] };
  return { kind: "campaign", primaryCampaignId: null, campaignIds: [] };
}

function collectCitations(results: ToolResult[]): Citation[] {
  const cites: Citation[] = [];
  for (const result of results) {
    if (!result.ok) continue;
    if ("citations" in result && Array.isArray(result.citations)) cites.push(...result.citations);
    if (result.tool === "get_campaign_metrics") {
      cites.push(...result.citations.filter((item) => ["clicks", "conversions", "cvr", "ctr"].includes(item.metric)));
    }
  }
  const seen = new Set<string>();
  return cites.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function bare(
  answer: string,
  kind: CopilotAnswer["kind"],
  citations: Citation[],
  series: TrendPoint[] | null,
  steps: InvestigationStep[],
  statusTrail: string[],
  investigation: InvestigationResultPayload | null
): InvestigationAnswer {
  return {
    answer,
    kind,
    evidence: citations.map((item) => ({
      label: item.label,
      value: item.value,
      source: `${item.source} · ${item.windowLabel}${item.compareLabel ? ` · ${item.compareLabel}` : ""} · Current ${item.value} · Prior ${item.baseline || "unavailable"}${item.absolute ? ` · Absolute ${item.absolute}` : ""}${item.points ? ` · ${item.points}` : ""}`,
      id: item.id,
      baseline: item.baseline,
      absolute: item.absolute,
      relative: item.relative,
      points: item.points,
      windowLabel: item.windowLabel,
      compareLabel: item.compareLabel,
      metric: item.metric,
    })),
    uncertainty: "Figures are deterministic calculations from the processed snapshot. Budget, bid, creative, landing-page, and verified spend fields are unavailable.",
    revision: null,
    sections: [],
    reviewReady: false,
    series,
    tools: [],
    steps,
    statusTrail,
    investigation,
    runtime: null,
  };
}

function mentioned(question: string) {
  return [...question.matchAll(/campaign\s+([a-z0-9]+)/gi)].map((item) => `Campaign ${item[1].toUpperCase()}`);
}

function isFalseCampaignMention(id: string) {
  return new Set([
    "Campaign SHOW",
    "Campaign DATA",
    "Campaign PERFORMANCE",
    "Campaign RESULTS",
    "Campaign SHOULD",
    "Campaign NEED",
    "Campaign NEEDS",
    "Campaign HAS",
    "Campaign HAVE",
  ]).has(id);
}

function traceFromAgent(
  agentRun: AgentRun,
  budget: ReturnType<typeof createInvestigationBudget>,
  investigationMode: InvestigationRuntimeTrace["investigationMode"],
  reportSynthesis: InvestigationRuntimeTrace["reportSynthesis"],
  validationIssueCount: number,
  fallbackCount: number
): InvestigationRuntimeTrace {
  return {
    investigationMode,
    toolSelection: agentRun.toolSelection,
    reportSynthesis,
    toolSelectionErrors: agentRun.toolSelectionErrors,
    synthesisErrors: [],
    validationIssueCount,
    fallbackLabel: agentRun.toolSelection === "llm_fallback" ? "Fallback to Rule-based Mode (tool selection)" : null,
    llmCallCount: budget.llmCalls,
    fallbackCount,
    elapsedMs: budget.elapsedMs(),
  };
}

export function toolPlanFor(question: string, model: ProductModel, findingId?: string | null) {
  const finding = model.findings.find((item) => item.id === findingId) || null;
  const scope = resolveAnalysisScope(question, finding?.campaignId || null, model);
  const campaignId = scope.primaryCampaignId || "Campaign R";
  return planTools(question, {
    question,
    accountId: model.account.id,
    windowId: finding?.windowId || model.window?.id || "recent_7d",
    campaignId,
    scope: scope.kind,
    scopedCampaignIds: scope.campaignIds.length ? scope.campaignIds : [campaignId],
    findingId: finding?.id || null,
    finding,
    peerCampaignIds: model.campaigns.map((item) => item.id).filter((id) => id !== campaignId),
    history: [],
  }).map((item) => item.tool);
}

import { ACTION_LABEL } from "./labels";
import { scrubWindowCopy } from "./windows";
import type { ActionType } from "@/lib/analytics/types";
import type { Proposal } from "./types";

const ACTION_ZH: Record<string, string> = {
  人工复核: ACTION_LABEL.review,
  提高优先级: ACTION_LABEL.increase_priority,
  增加优先级: ACTION_LABEL.increase_priority,
  降低优先级: ACTION_LABEL.decrease_priority,
  继续观察: ACTION_LABEL.hold,
  继续监测: ACTION_LABEL.hold,
  暂停前复核: ACTION_LABEL.pause_candidate,
};

const EXACT: Record<string, string> = {
  点击: "Clicks",
  转化: "Conversion-linked clicks",
  转化关联点击: "Conversion-linked clicks",
  点击后转化率: "Post-click conversion-link rate",
  曝光: "Impressions",
  成本指数: "Cost index",
  成本指数总值: "Cost index total",
  单次点击成本指数: "Average cost index per click",
  "为什么这条是高优先级？": "Why is this high priority?",
  下一步该检查什么: "What should we check next?",
  切换到查看者: "Switched to viewer",
  切换到优化师: "Switched to analyst",
  提交审批: "Submitted for confirmation",
  切换到审批人: "Switched to approver",
  "批准建议。批准还不是执行。": "Confirmed the recommendation. Confirmation is not platform execution.",
  "导出执行方案。这不是广告平台执行。": "Exported the decision record. This is not advertising-platform execution.",
  保存了当前建议草稿: "Saved the current recommendation draft",
  切换到管理员: "Switched to administrator",
  修改了建议动作或说明: "Edited the recommended action or rationale",
};

const FRAGMENTS: Array<[RegExp, string]> = [
  [/基于当前目标生成\s*(\d+)\s*条策略建议/g, "Generated $1 strategy recommendations from the current goal"],
  [/用户接受策略/g, "User accepted the strategy"],
  [/最近 7 天转化相关指标出现明显下滑，应作为暂停候选进入人工复核。/g, "Conversion-linked metrics declined over the last 7 days and should enter review-before-pausing."],
  [/与当前有效转化或风险控制目标相关，近期转化效率或点击到转化效率偏弱。/g, "This campaign is related to the current conversion-efficiency or risk-control goal, and recent conversion-link efficiency is weak."],
  [/具备最高转化指标，可优先加权。/g, "has the strongest conversion-link metrics and can be prioritized."],
  [/归因转化效率低于/g, "attributed conversion-link efficiency is below"],
  [/且当前目标更偏重有效转化。/g, "and the current goal emphasizes conversion-linked efficiency."],
  [/等低效 Campaign 值得优先处理/g, "and other weaker campaigns are worth reviewing first"],
  [/Campaign\s+([A-Z0-9]+)\s*是高优先级的转化率异常。高优先级只在降幅和样本同时过线时出现。/g, "Campaign $1 is a high-priority conversion-link-rate anomaly. High priority only appears when both the decline and the sample size clear the rule thresholds."],
  [/下一步是核验缺口，而不是把假设写成原因。当前候选动作是暂停前复核。/g, "The next step is to verify the data gaps, not to write hypotheses as causes. The current candidate action is review-before-pausing."],
  [/Campaign\s+([A-Z0-9]+)\s*的点击在增加，转化次数和点击后转化率在下降。这是对照窗口里已经算出的结果，还不是原因。/g, "Campaign $1 clicks rose while conversion-linked clicks and post-click conversion-link rate fell. That is already computed against the comparison window; it is not a cause."],
  [/现有字段解释不了 Campaign\s+([A-Z0-9]+)\s*的根因。缺的是能把下面这些假设证伪的数据，不是另一份指标摘要。/g, "The available fields cannot explain Campaign $1's root cause. What is missing is data that could falsify the hypotheses below, not another metric summary."],
  [/更稳妥的候选是把暂停前复核改成人工复核。这只是候选，保存后才进入草稿，不会自动审批。/g, "The more conservative candidate is to change review-before-pausing to manual review. This is only a candidate; it becomes a draft after save and is not auto-confirmed."],
  [/最初的规则建议是暂停前复核。若采用更稳妥的候选，动作会变成人工复核。目前还没保存，所以正式方案仍是暂停前复核。/g, "The original rule recommendation was review-before-pausing. If the more conservative candidate is used, the action becomes manual review. Nothing has been saved yet, so the formal proposal is still review-before-pausing."],
  [/当前状态是exported。对话不能把已处理的建议再自动提交一次。/g, "The current status is exported. The conversation cannot auto-submit an already handled recommendation again."],
  [/当前状态是已导出。对话不能把已处理的建议再自动提交一次。/g, "The current status is exported. The conversation cannot auto-submit an already handled recommendation again."],
  [/现有规则把它标成转化率异常，依据是：点击后转化率的变化幅度超过阈值，转化次数也在减少。判断依据是该计划自身的对照窗口，不是账户里每一次下降。/g, "The current rule flags a conversion-link-rate anomaly because the post-click conversion-link rate moved beyond the threshold and conversion-linked clicks also fell. This uses this campaign's own comparison window, not every decline in the account."],
  [/点击后转化率的变化幅度超过阈值，转化次数也在减少。判断依据是该计划自身的对照窗口，不是账户里每一次下降。/g, "The post-click conversion-link rate moved beyond the rule threshold, and conversion-linked clicks also fell. This judgment uses this campaign's own comparison window, not every decline in the account."],
  [/这些数字说明表现变了，还不能确定根因。/g, "These numbers show that performance changed; they do not establish a root cause."],
  [/这些数字说明表现变化，还不能确定根因。/g, "These numbers show a performance change; they do not establish a root cause."],
  [/当前字段里没有素材、落地页或受众，不能判断下降是不是素材造成的。/g, "This dataset has no creative, landing-page, or audience fields, so the decline cannot be attributed to creatives."],
  [/下一步只能核验现有字段和窗口，不能估算预算或出价调整的收益。/g, "The next step can only verify the available fields and windows; it cannot estimate the return from a budget or bid change."],
  [/没有名为 Campaign\s+([A-Z0-9]+)\s*的计划。\s*没有用其他数据补上这个结果。/g, "There is no campaign named Campaign $1. No other data was used to fill in this result."],
  [/当前数据集没有素材或受众维度，不能把表现变化归因到这些因素。/g, "This dataset has no creative or audience dimensions, so the performance change cannot be attributed to those factors."],
  [/低于日均的转化里，D(\d+)\s*占了较大一部分。点击后转化率最低的是 D(\d+)/g, "Among below-average conversion-linked days, D$1 accounts for a large share. The lowest post-click conversion-link rate is D$2"],
  [/这只说明日级分布，不是某一小时，也不是根因。/g, "This only describes the daily distribution; it is not an hourly pattern and not a root cause."],
  [/横轴是 D1–D31 里的相对天数，不是公历日期，也不是小时。/g, "The x-axis is relative days in D1–D31, not calendar dates and not hours."],
  [/点击后转化率的变化方向一致。/g, "The post-click conversion-link-rate direction is the same."],
  [/这只是同窗口比较，不能由此确定共同根因。绝对转化量受规模影响，这里不拿它比效率。/g, "This is a same-window comparison and does not establish a shared root cause. Absolute conversion-linked volume is scale-dependent and is not used here as an efficiency comparison."],
  [/现有诊断是转化率异常，高优先级。/g, "The current diagnosis is a conversion-link-rate anomaly, high priority."],
  [/现有诊断是转化率异常，中优先级。/g, "The current diagnosis is a conversion-link-rate anomaly, medium priority."],
  [/处理时间是/g, "Snapshot time is"],
  [/不是这些相对天数的公历日期。/g, "This is not a calendar date for those relative days."],
  [/数据快照/g, "Dataset snapshot"],
  [/不是实时平台/g, "not a live platform"],
  [/调查报告/g, "Investigation Report"],
  [/已记录审批时看到的基线。当前数据集没有更晚的同步，不能把现有窗口差异说成这次操作造成的效果。/g, "The confirmation-time baseline is recorded. No newer dataset exists, so the current window cannot be presented as an outcome caused by this action."],
  [/Campaign\s+([A-Z0-9]+)\s*先采用人工复核，不使用暂停前复核。/g, "Campaign $1 uses manual review rather than review-before-pausing."],
  [/近\s*7\s*天\s*·\s*/g, ""],
  [/前\s*7\s*天\s*·\s*/g, ""],
  [/全周期\s*·\s*/g, ""],
  [/对照对照\s*·\s*/g, "Comparison · "],
  [/对照\s*·\s*/g, "Comparison · "],
  [/点击后转化率/g, "post-click conversion-link rate"],
  [/转化关联点击/g, "conversion-linked clicks"],
  [/没有相对变化/g, "no relative change"],
  [/对照 无/g, "no comparison"],
  [/个百分点/g, " pp"],
  [/暂停前复核/g, "review-before-pausing"],
  [/人工复核/g, "manual review"],
  [/转化率异常/g, "conversion-link-rate anomaly"],
  [/高优先级/g, "high priority"],
  [/中优先级/g, "medium priority"],
  [/相对变化/g, "relative change"],
  [/相对/g, "relative"],
  [/绝对/g, "absolute"],
  [/当前/g, "current"],
  [/对照/g, "comparison"],
  [/点击/g, "clicks"],
  [/转化/g, "conversion-linked clicks"],
  [/日级结果/g, "daily results"],
  [/在\s+/g, " in "],
];

const LOST_COPY = "The original Chinese copy was replaced with an English decision record.";

export function hasChinese(value: string | null | undefined) {
  return /[\u3400-\u9fff]/.test(value || "");
}

export function isLostEnglishCopy(value: string | null | undefined) {
  return (value || "").includes(LOST_COPY);
}

export function englishWindowLabel(value: string | null | undefined) {
  if (!value) return "";
  const scrubbed = scrubWindowCopy(value)
    .replace(/前\s*7\s*天/g, "")
    .replace(/近\s*7\s*天/g, "")
    .replace(/全周期/g, "")
    .replace(/[·•]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const range = scrubbed.match(/D\s*\d+\s*[–-]\s*D\s*\d+/i);
  if (range) return range[0].replace(/\s+/g, "").replace(/D(\d+)-D(\d+)/i, "D$1–D$2");
  return hasChinese(scrubbed) ? "" : scrubbed;
}

const DIAGNOSTIC_BLOCK =
  /(Campaign\s+[A-Z0-9]+)\s*在(?:近\s*7\s*天\s*·\s*)?(D\s*\d+\s*[–-]\s*D\s*\d+)\s*有\s*([\d,]+)\s*次点击[、,]\s*([\d,]+)\s*次转化[，,]\s*点击后转化率\s*([^。]+)。对照窗口为\s*([\d,]+)\s*次点击[、,]\s*([\d,]+)\s*次转化[、,]\s*点击后转化率\s*([^。]+)。(?:点击后转化率的变化幅度超过阈值，转化次数也在减少。判断依据是该计划自身的对照窗口，不是账户里每一次下降。)*/;

export function englishProposalText(value: string | null | undefined, actionType?: ActionType | string | null) {
  let text = (value || "").trim();
  if (!text) return "";
  if (!hasChinese(text)) {
    return text.replace(/Approval still requires/g, "Confirmation still requires");
  }

  const diagnostic = text.match(DIAGNOSTIC_BLOCK);
  if (diagnostic) {
    const windowLabel = diagnostic[2].replace(/\s+/g, "").replace(/D(\d+)-D(\d+)/i, "D$1–D$2");
    const english = `${diagnostic[1]} recorded ${diagnostic[3]} clicks and ${diagnostic[4]} conversion-linked clicks in ${windowLabel}, for a post-click conversion-link rate of ${diagnostic[5].trim()}. The comparison window recorded ${diagnostic[6]} clicks, ${diagnostic[7]} conversion-linked clicks, and a ${diagnostic[8].trim()} conversion-link rate. The post-click conversion-link rate moved beyond the rule threshold, and conversion-linked clicks also fell. This judgment uses this campaign's own comparison window, not every decline in the account.`;
    text = text.replace(diagnostic[0], english);
    if (!hasChinese(text)) return text;
  }

  const observed = text.match(/当前观察：点击\s*([\d,]+)，点击后转化率\s*([^，,]+)，相对对照\s*([^。]+)/);
  if (observed) {
    return `No budget or bid field is available. Verified observation: ${observed[1]} clicks, ${observed[2]} post-click conversion-link rate, ${observed[3]} versus the prior window.`;
  }
  if (/没有可读取的预算或出价/.test(text) && text.length < 80) {
    return "No budget or bid field is available. The verified observation is limited to clicks and post-click conversion-link rate.";
  }
  if (/没有可读取的预算或出价/.test(text)) {
    const inner = text.match(/当前观察：点击\s*([\d,]+)，点击后转化率\s*([^，,]+)，相对对照\s*([^。]+)/);
    if (inner) {
      return `No budget or bid field is available. Verified observation: ${inner[1]} clicks, ${inner[2]} post-click conversion-link rate, ${inner[3]} versus the prior window.`;
    }
  }

  const proposed = text.match(/建议动作是([^。]+)/);
  if (proposed || (/批准后仍需导出/.test(text) && text.length < 120)) {
    const action = ACTION_ZH[proposed?.[1]?.trim() || ""] || ACTION_LABEL[(actionType as ActionType) || "review"] || "Manual review";
    return `Proposed action: ${action}. Confirmation still requires an export or an external platform action; AdPilot does not change campaign delivery directly.`;
  }

  if (/样本足够.*人工复核.*不降低优先级/.test(text)) {
    return "The sample was sufficient; the recorded decision was manual review without lowering priority.";
  }
  if (/人工复核本身不改变投放/.test(text) && text.length < 80) {
    return "Manual review does not change campaign delivery.";
  }
  if (EXACT[text]) return EXACT[text];
  if (/^影响范围限于/.test(text)) return text.replace(/^影响范围限于\s*/, "Scope is limited to ").replace(/。$/, ".");
  if (/会被标成暂停前复核/.test(text) && text.length < 160) {
    return text.replace(/会被标成暂停前复核。这不是已执行的暂停，也没有暂停接口。/, "is flagged as review-before-pausing. This is not an executed pause, and no pause API exists.");
  }
  if (/基于历史日志的离线权重比较/.test(text)) {
    return "This offline weighting uses historical logs for directional comparison only; it is not a forecast of platform results.";
  }
  if (/当前没有可靠的效果估计/.test(text)) {
    return "No reliable outcome estimate is available. Offline weighting only compares directions in historical logs; it is not a forecast of platform results.";
  }

  if (text.length < 80) {
    const actionHit = Object.keys(ACTION_ZH).find((key) => text.includes(key));
    if (actionHit) {
      const name = text.match(/Campaign\s+[A-Z0-9]+/i)?.[0];
      const action = ACTION_ZH[actionHit];
      return name ? `${name}: ${action}` : action;
    }
  }

  text = applyFragments(text).replace(/：/g, ":");
  if (!hasChinese(text)) return text.replace(/\s+/g, " ").trim();
  return text.replace(/[\u3400-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
}

function applyFragments(text: string) {
  let next = text;
  for (const [pattern, replacement] of FRAGMENTS) next = next.replace(pattern, replacement);
  return next;
}

export function englishStoredProposal(proposal: Proposal): Proposal {
  return {
    ...proposal,
    title: englishProposalText(proposal.title, proposal.actionType) || proposal.title,
    reason: englishProposalText(proposal.reason, proposal.actionType) || proposal.reason,
    currentState: englishProposalText(proposal.currentState, proposal.actionType) || proposal.currentState,
    proposedState: englishProposalText(proposal.proposedState, proposal.actionType) || proposal.proposedState,
    riskNote: englishProposalText(proposal.riskNote, proposal.actionType) || proposal.riskNote,
  };
}

import re

from app.services.copilot.labels import ACTION_LABEL

ACTION_ZH = {
    "人工复核": ACTION_LABEL["review"],
    "提高优先级": ACTION_LABEL["increase_priority"],
    "增加优先级": ACTION_LABEL["increase_priority"],
    "降低优先级": ACTION_LABEL["decrease_priority"],
    "继续观察": ACTION_LABEL["hold"],
    "继续监测": ACTION_LABEL["hold"],
    "暂停前复核": ACTION_LABEL["pause_candidate"],
}

CHINESE = re.compile(r"[\u3400-\u9fff]")

EXACT = {
    "点击": "Clicks",
    "转化": "Conversion-linked clicks",
    "转化关联点击": "Conversion-linked clicks",
    "点击后转化率": "Post-click conversion-link rate",
    "曝光": "Impressions",
    "成本指数": "Cost index",
    "成本指数总值": "Cost index total",
    "单次点击成本指数": "Average cost index per click",
    "为什么这条是高优先级？": "Why is this high priority?",
    "下一步该检查什么": "What should we check next?",
    "切换到查看者": "Switched to viewer",
    "切换到优化师": "Switched to analyst",
    "提交审批": "Submitted for confirmation",
    "切换到审批人": "Switched to approver",
    "批准建议。批准还不是执行。": "Confirmed the recommendation. Confirmation is not platform execution.",
    "导出执行方案。这不是广告平台执行。": "Exported the decision record. This is not advertising-platform execution.",
    "保存了当前建议草稿": "Saved the current recommendation draft",
    "切换到管理员": "Switched to administrator",
    "修改了建议动作或说明": "Edited the recommended action or rationale",
}

FRAGMENTS = [
    (r"基于当前目标生成\s*(\d+)\s*条策略建议", r"Generated \1 strategy recommendations from the current goal"),
    (r"用户接受策略", "User accepted the strategy"),
    (r"最近 7 天转化相关指标出现明显下滑，应作为暂停候选进入人工复核。", "Conversion-linked metrics declined over the last 7 days and should enter review-before-pausing."),
    (r"与当前有效转化或风险控制目标相关，近期转化效率或点击到转化效率偏弱。", "This campaign is related to the current conversion-efficiency or risk-control goal, and recent conversion-link efficiency is weak."),
    (r"具备最高转化指标，可优先加权。", "has the strongest conversion-link metrics and can be prioritized."),
    (r"归因转化效率低于", "attributed conversion-link efficiency is below"),
    (r"且当前目标更偏重有效转化。", "and the current goal emphasizes conversion-linked efficiency."),
    (r"等低效 Campaign 值得优先处理", "and other weaker campaigns are worth reviewing first"),
    (r"Campaign\s+([A-Z0-9]+)\s*是高优先级的转化率异常。高优先级只在降幅和样本同时过线时出现。", r"Campaign \1 is a high-priority conversion-link-rate anomaly. High priority only appears when both the decline and the sample size clear the rule thresholds."),
    (r"下一步是核验缺口，而不是把假设写成原因。当前候选动作是暂停前复核。", "The next step is to verify the data gaps, not to write hypotheses as causes. The current candidate action is review-before-pausing."),
    (r"Campaign\s+([A-Z0-9]+)\s*的点击在增加，转化次数和点击后转化率在下降。这是对照窗口里已经算出的结果，还不是原因。", r"Campaign \1 clicks rose while conversion-linked clicks and post-click conversion-link rate fell. That is already computed against the comparison window; it is not a cause."),
    (r"现有字段解释不了 Campaign\s+([A-Z0-9]+)\s*的根因。缺的是能把下面这些假设证伪的数据，不是另一份指标摘要。", r"The available fields cannot explain Campaign \1's root cause. What is missing is data that could falsify the hypotheses below, not another metric summary."),
    (r"更稳妥的候选是把暂停前复核改成人工复核。这只是候选，保存后才进入草稿，不会自动审批。", "The more conservative candidate is to change review-before-pausing to manual review. This is only a candidate; it becomes a draft after save and is not auto-confirmed."),
    (r"最初的规则建议是暂停前复核。若采用更稳妥的候选，动作会变成人工复核。目前还没保存，所以正式方案仍是暂停前复核。", "The original rule recommendation was review-before-pausing. If the more conservative candidate is used, the action becomes manual review. Nothing has been saved yet, so the formal proposal is still review-before-pausing."),
    (r"当前状态是exported。对话不能把已处理的建议再自动提交一次。", "The current status is exported. The conversation cannot auto-submit an already handled recommendation again."),
    (r"当前状态是已导出。对话不能把已处理的建议再自动提交一次。", "The current status is exported. The conversation cannot auto-submit an already handled recommendation again."),
    (r"现有规则把它标成转化率异常，依据是：点击后转化率的变化幅度超过阈值，转化次数也在减少。判断依据是该计划自身的对照窗口，不是账户里每一次下降。", "The current rule flags a conversion-link-rate anomaly because the post-click conversion-link rate moved beyond the threshold and conversion-linked clicks also fell. This uses this campaign's own comparison window, not every decline in the account."),
    (r"点击后转化率的变化幅度超过阈值，转化次数也在减少。判断依据是该计划自身的对照窗口，不是账户里每一次下降。", "The post-click conversion-link rate moved beyond the rule threshold, and conversion-linked clicks also fell. This judgment uses this campaign's own comparison window, not every decline in the account."),
    (r"这些数字说明表现变了，还不能确定根因。", "These numbers show that performance changed; they do not establish a root cause."),
    (r"这些数字说明表现变化，还不能确定根因。", "These numbers show a performance change; they do not establish a root cause."),
    (r"当前字段里没有素材、落地页或受众，不能判断下降是不是素材造成的。", "This dataset has no creative, landing-page, or audience fields, so the decline cannot be attributed to creatives."),
    (r"下一步只能核验现有字段和窗口，不能估算预算或出价调整的收益。", "The next step can only verify the available fields and windows; it cannot estimate the return from a budget or bid change."),
    (r"没有名为 Campaign\s+([A-Z0-9]+)\s*的计划。\s*没有用其他数据补上这个结果。", r"There is no campaign named Campaign \1. No other data was used to fill in this result."),
    (r"当前数据集没有素材或受众维度，不能把表现变化归因到这些因素。", "This dataset has no creative or audience dimensions, so the performance change cannot be attributed to those factors."),
    (r"已记录审批时看到的基线。当前数据集没有更晚的同步，不能把现有窗口差异说成这次操作造成的效果。", "The confirmation-time baseline is recorded. No newer dataset exists, so the current window cannot be presented as an outcome caused by this action."),
    (r"Campaign\s+([A-Z0-9]+)\s*先采用人工复核，不使用暂停前复核。", r"Campaign \1 uses manual review rather than review-before-pausing."),
    (r"近\s*7\s*天\s*·\s*", ""),
    (r"前\s*7\s*天\s*·\s*", ""),
    (r"全周期\s*·\s*", ""),
    (r"对照对照\s*·\s*", "Comparison · "),
    (r"对照\s*·\s*", "Comparison · "),
    (r"点击后转化率", "post-click conversion-link rate"),
    (r"转化关联点击", "conversion-linked clicks"),
    (r"没有相对变化", "no relative change"),
    (r"对照 无", "no comparison"),
    (r"个百分点", " pp"),
    (r"暂停前复核", "review-before-pausing"),
    (r"人工复核", "manual review"),
    (r"转化率异常", "conversion-link-rate anomaly"),
    (r"高优先级", "high priority"),
    (r"中优先级", "medium priority"),
    (r"相对变化", "relative change"),
    (r"相对", "relative"),
    (r"绝对", "absolute"),
    (r"当前", "current"),
    (r"对照", "comparison"),
    (r"点击", "clicks"),
    (r"转化", "conversion-linked clicks"),
    (r"调查报告", "Investigation Report"),
    (r"不是实时平台", "not a live platform"),
    (r"数据快照", "Dataset snapshot"),
    (r"处理时间是", "Snapshot time is"),
    (r"不是这些相对天数的公历日期。", "This is not a calendar date for those relative days."),
    (r"日级结果", "daily results"),
    (r"在\s+", " in "),
]


def apply_fragments(text: str) -> str:
    next_text = text
    for pattern, replacement in FRAGMENTS:
        next_text = re.sub(pattern, replacement, next_text)
    return next_text


def has_chinese(value: str | None) -> bool:
    return bool(value and CHINESE.search(value))


def english_window_label(value: str | None) -> str:
    if not value:
        return ""
    text = value
    for prefix in (
        "Selected window · ",
        "Prior comparison · ",
        "Snapshot window · ",
        "Comparison window · ",
        "Full snapshot · ",
        "Recent 7 days · ",
        "Previous 7 days · ",
        "Full range · ",
    ):
        text = text.replace(prefix, "")
    text = re.sub(r"前\s*7\s*天", "", text)
    text = re.sub(r"近\s*7\s*天", "", text)
    text = text.replace("全周期", "")
    text = re.sub(r"对照\s*·\s*", "", text)
    text = text.replace("对照", "")
    text = re.sub(r"[·•]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    match = re.search(r"D\s*\d+\s*[–-]\s*D\s*\d+", text, re.I)
    if match:
        return re.sub(r"D(\d+)-D(\d+)", r"D\1–D\2", re.sub(r"\s+", "", match.group(0)), flags=re.I)
    return "" if has_chinese(text) else text


def english_proposal_text(value: str | None, action_type: str | None = None) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    if not has_chinese(text):
        return text.replace("Approval still requires", "Confirmation still requires")

    diagnostic = re.search(
        r"(Campaign\s+[A-Z0-9]+)\s*在(?:近\s*7\s*天\s*·\s*)?(D\s*\d+\s*[–-]\s*D\s*\d+)\s*有\s*([\d,]+)\s*次点击[、,]\s*([\d,]+)\s*次转化[，,]\s*点击后转化率\s*([^。]+)。对照窗口为\s*([\d,]+)\s*次点击[、,]\s*([\d,]+)\s*次转化[、,]\s*点击后转化率\s*([^。]+)。",
        text,
    )
    if diagnostic:
        window_label = re.sub(r"D(\d+)-D(\d+)", r"D\1–D\2", re.sub(r"\s+", "", diagnostic.group(2)), flags=re.I)
        english = (
            f"{diagnostic.group(1)} recorded {diagnostic.group(3)} clicks and {diagnostic.group(4)} conversion-linked clicks in {window_label}, "
            f"for a post-click conversion-link rate of {diagnostic.group(5).strip()}. "
            f"The comparison window recorded {diagnostic.group(6)} clicks, {diagnostic.group(7)} conversion-linked clicks, and a {diagnostic.group(8).strip()} conversion-link rate. "
            "The post-click conversion-link rate moved beyond the rule threshold, and conversion-linked clicks also fell. "
            "This judgment uses this campaign's own comparison window, not every decline in the account."
        )
        text = text.replace(diagnostic.group(0), english)
        if not has_chinese(text):
            return text

    observed = re.search(r"当前观察：点击\s*([\d,]+)，点击后转化率\s*([^，,]+)，相对对照\s*([^。]+)", text)
    if observed:
        return (
            f"No budget or bid field is available. Verified observation: {observed.group(1)} clicks, "
            f"{observed.group(2)} post-click conversion-link rate, {observed.group(3)} versus the prior window."
        )
    if "没有可读取的预算或出价" in text:
        return "No budget or bid field is available. The verified observation is limited to clicks and post-click conversion-link rate."

    proposed = re.search(r"建议动作是([^。]+)", text)
    if proposed or "批准后仍需导出" in text:
        action = ACTION_ZH.get((proposed.group(1).strip() if proposed else ""), ACTION_LABEL.get(action_type or "review", "Manual review"))
        return (
            f"Proposed action: {action}. Confirmation still requires an export or an external platform action; "
            "AdPilot does not change campaign delivery directly."
        )

    if re.search(r"样本足够.*人工复核.*不降低优先级", text):
        return "The sample was sufficient; the recorded decision was manual review without lowering priority."
    if "人工复核本身不改变投放" in text and len(text) < 80:
        return "Manual review does not change campaign delivery."
    if text in EXACT:
        return EXACT[text]
    if text.startswith("影响范围限于"):
        return text.replace("影响范围限于", "Scope is limited to ", 1).rstrip("。") + "."
    if "会被标成暂停前复核" in text and len(text) < 160:
        return text.replace("会被标成暂停前复核。这不是已执行的暂停，也没有暂停接口。", "is flagged as review-before-pausing. This is not an executed pause, and no pause API exists.")
    if "基于历史日志的离线权重比较" in text:
        return "This offline weighting uses historical logs for directional comparison only; it is not a forecast of platform results."
    if "当前没有可靠的效果估计" in text:
        return "No reliable outcome estimate is available. Offline weighting only compares directions in historical logs; it is not a forecast of platform results."
    if len(text) < 80:
        for key, action in ACTION_ZH.items():
            if key in text:
                name = re.search(r"Campaign\s+[A-Z0-9]+", text, re.I)
                return f"{name.group(0)}: {action}" if name else action
    text = apply_fragments(text).replace("：", ":")
    if not has_chinese(text):
        return re.sub(r"\s+", " ", text).strip()
    return re.sub(r"\s+", " ", re.sub(r"[\u3400-\u9fff]+", " ", text)).strip()


def english_stored_proposal(proposal: dict | None) -> dict:
    if not proposal:
        return {}
    action_type = proposal.get("actionType")
    return {
        **proposal,
        "title": english_proposal_text(proposal.get("title"), action_type) or proposal.get("title"),
        "reason": english_proposal_text(proposal.get("reason"), action_type) or proposal.get("reason"),
        "currentState": english_proposal_text(proposal.get("currentState"), action_type) or proposal.get("currentState"),
        "proposedState": english_proposal_text(proposal.get("proposedState"), action_type) or proposal.get("proposedState"),
        "riskNote": english_proposal_text(proposal.get("riskNote"), action_type) or proposal.get("riskNote"),
    }

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from app.services.copilot.investigate.llm_config import is_real_llm_configured
from app.services.copilot.investigate.tools import (
    analyze_attribution,
    analyze_daily_trend,
    compare_campaigns,
    detect_anomalous_days,
    get_campaign_metrics,
    retrieve_decision_history,
)
from app.services.llm.provider import get_llm_provider_from_env

MAX_CALLS = 6
TOOL_TIMEOUT_MS = 12000

TOOL_LABEL = {
    "get_campaign_metrics": "Campaign window metrics",
    "analyze_daily_trend": "Daily trend analysis",
    "compare_campaigns": "Campaign comparison",
    "analyze_attribution": "Attribution metrics",
    "detect_anomalous_days": "Anomaly day detection",
    "retrieve_decision_history": "Decision history",
}

STATUS_LABEL = {
    "get_campaign_metrics": "Analyzing campaign performance…",
    "analyze_daily_trend": "Comparing daily trends…",
    "compare_campaigns": "Checking other campaigns…",
    "analyze_attribution": "Reviewing attribution metrics…",
    "detect_anomalous_days": "Scanning daily anomalies…",
    "retrieve_decision_history": "Loading findings and decisions…",
}


async def with_timeout(coro, timeout_ms=TOOL_TIMEOUT_MS):
    return await asyncio.wait_for(coro, timeout=timeout_ms / 1000)


def normalize_campaign_ids(ids: list[str]) -> list[str]:
    return list(dict.fromkeys([i.strip() for i in ids if i and i.strip()]))


def mentioned_peers(question: str) -> list[str]:
    return [f"Campaign {m.group(1).upper()}" for m in re.finditer(r"campaign\s+([a-z0-9]+)", question, re.I)]


def rule_pick_tool(ctx: dict, results: list, called: set, first: bool) -> dict | None:
    """Mirror apps/web/lib/copilot/investigate/agent.ts rulePickTool."""
    q = ctx["question"].lower()
    peers = [p for p in mentioned_peers(ctx["question"]) if p.lower() != ctx["campaignId"].lower()]

    if re.search(r"which campaign should|review first|prioriti[sz]e first|first human review", q):
        if "compare_campaigns" not in called:
            return {"tool": "compare_campaigns", "campaignIds": ctx.get("scopedCampaignIds")}
        return None
    if re.search(r"high priority|flagged as high|re-?check|i meant|actually happened", q) and not re.search(
        r"daily|sustained|concentrated|few dates|few days|trend", q
    ):
        if "get_campaign_metrics" not in called:
            return {"tool": "get_campaign_metrics"}
        return None

    if ctx.get("scope") in ("account", "comparison") and "compare_campaigns" not in called:
        return {"tool": "compare_campaigns", "campaignIds": ctx.get("scopedCampaignIds")}

    if re.search(r"原建议|已导出|审批|proposal|导出|decision history|决策历史", q) and "retrieve_decision_history" not in called:
        return {"tool": "retrieve_decision_history"}
    if re.search(r"归因|attribution|attributed", q) and "analyze_attribution" not in called:
        return {"tool": "analyze_attribution"}
    if re.search(r"worst day|异常日|anomal|哪一天|particular day|outlier|spike|drop day", q) and "detect_anomalous_days" not in called:
        return {"tool": "detect_anomalous_days"}
    if re.search(r"异常日|anomal|哪一天|particular day|daily|趋势|trend|按日|sustained|concentrated|few days|few dates", q) and "analyze_daily_trend" not in called:
        return {"tool": "analyze_daily_trend", "span": "both"}
    if (peers or re.search(r"other campaign|同样|same pattern|isolated|worse|better", q)) and "compare_campaigns" not in called:
        return {"tool": "compare_campaigns", "campaignIds": [ctx["campaignId"], *peers] if peers else None}
    if re.search(r"异常|outlier|spike|drop day", q) and "detect_anomalous_days" not in called:
        return {"tool": "detect_anomalous_days"}
    if re.search(r"素材|creative|落地页|受众|audience|budget|预算|roas|landing|spend|fatigue", q):
        if (peers or re.search(r"both campaigns|campaign r.*campaign d|campaign d.*campaign r", q)) and "compare_campaigns" not in called:
            return {"tool": "compare_campaigns", "campaignIds": [ctx["campaignId"], *peers] if peers else None}
        if "get_campaign_metrics" not in called:
            return {"tool": "get_campaign_metrics"}
        return None
    if re.search(r"recommend(?:ation)?|what action|which action|next action|proposal|create decision|compil(?:e|ed)|decision draft", q):
        if "get_campaign_metrics" not in called:
            return {"tool": "get_campaign_metrics"}
        if ctx.get("findingId") and "retrieve_decision_history" not in called:
            return {"tool": "retrieve_decision_history"}
        return None
    if re.search(r"下一步|investigate next|what should|verify next|核验|verify", q):
        if ctx.get("findingId") and "retrieve_decision_history" not in called:
            return {"tool": "retrieve_decision_history"}
        if "analyze_daily_trend" not in called:
            return {"tool": "analyze_daily_trend", "span": "both"}
        if "get_campaign_metrics" not in called:
            return {"tool": "get_campaign_metrics"}
        return None
    if first and "get_campaign_metrics" not in called and re.search(r"why|为什么|decline|下降|cvr|转化率|efficiency", q):
        return {"tool": "get_campaign_metrics"}
    if "get_campaign_metrics" not in called and first:
        return {"tool": "get_campaign_metrics"}
    if re.search(r"why|为什么|decline|下降|efficiency", q):
        if "get_campaign_metrics" not in called:
            return {"tool": "get_campaign_metrics"}
        if ctx.get("findingId") and "retrieve_decision_history" not in called:
            return {"tool": "retrieve_decision_history"}
        if "analyze_daily_trend" not in called:
            return {"tool": "analyze_daily_trend", "span": "both"}
        return None
    if "get_campaign_metrics" not in called and "analyze_daily_trend" in called:
        return {"tool": "get_campaign_metrics"}
    return None


def summarize_tool(result: dict) -> str:
    if not result.get("ok"):
        return result.get("message", "failed")
    tool = result.get("tool")
    if tool == "get_campaign_metrics":
        return f"{result.get('campaignName')} window metrics for {result.get('windowLabel')}"
    if tool == "analyze_daily_trend":
        return f"{result.get('campaignName')} daily trend across {len(result.get('points') or [])} days"
    if tool == "compare_campaigns":
        return f"{len(result.get('rows') or [])} campaigns compared"
    if tool == "analyze_attribution":
        return f"{result.get('campaignName')} attribution share {result.get('attributionShare', 'n/a')}"
    if tool == "detect_anomalous_days":
        days = result.get("days") or []
        return f"{sum(1 for d in days if d.get('notable'))} notable days"
    if tool == "retrieve_decision_history":
        return f"{len(result.get('entries') or [])} history records"
    return "completed"


def execute_tool(call: dict, ctx: dict) -> dict:
    scope = (ctx.get("finding") or {}).get("windowId") or ctx["windowId"]
    tool = call["tool"]
    if tool == "get_campaign_metrics":
        return get_campaign_metrics(ctx["campaignId"], scope)
    if tool == "analyze_daily_trend":
        return analyze_daily_trend(ctx["campaignId"], scope, call.get("span") or "both")
    if tool == "compare_campaigns":
        if call.get("campaignIds"):
            ids = call["campaignIds"]
        elif len(ctx.get("scopedCampaignIds") or []) > 1:
            ids = ctx["scopedCampaignIds"]
        else:
            ids = [ctx["campaignId"], *mentioned_peers(ctx["question"]), *(ctx.get("peerCampaignIds") or [])[:2]]
        return compare_campaigns(normalize_campaign_ids(ids), scope)
    if tool == "analyze_attribution":
        return analyze_attribution(ctx["campaignId"], scope)
    if tool == "detect_anomalous_days":
        return detect_anomalous_days(ctx["campaignId"], scope)
    if tool == "retrieve_decision_history":
        return retrieve_decision_history(ctx["accountId"], scope, ctx.get("findingId"), ctx["campaignId"])
    return {"ok": False, "tool": "get_campaign_metrics", "message": "The requested tool is not allowlisted."}


async def llm_pick_tool(ctx: dict, results: list, called: set, budget) -> dict | None | bool:
    provider = get_llm_provider_from_env()
    all_tools = [t for t in TOOL_LABEL if t not in called]
    if not all_tools:
        return None
    payload = {
        "question": ctx["question"],
        "campaignId": ctx["campaignId"],
        "analysisScope": ctx.get("scope"),
        "scopedCampaignIds": ctx.get("scopedCampaignIds"),
        "findingId": ctx.get("findingId"),
        "alreadyCalled": list(called),
        "priorSummaries": [summarize_tool(r) if r.get("ok") else r.get("message") for r in results],
        "recentConversation": (ctx.get("history") or [])[-6:],
        "allowedTools": all_tools,
    }
    system = (
        'You are an advertising investigation agent. Select exactly one next tool or stop. '
        'Return JSON {"action":"call"|"stop","tool":"...","campaignIds":["Campaign X"],"span":"both"|"current"|"all"}. '
        "Never claim or recommend that an advertising-platform change has been executed."
    )
    raw = await with_timeout(provider.generate_structured(system, json.dumps(payload)))
    if raw.get("action") == "stop" or not raw.get("tool"):
        return None
    if raw["tool"] not in all_tools:
        return False
    span = raw.get("span")
    if span not in ("current", "all", "both"):
        span = "both"
    campaign_ids = normalize_campaign_ids(raw.get("campaignIds") or []) if raw.get("campaignIds") else None
    return {"tool": raw["tool"], "campaignIds": campaign_ids, "span": span}


async def pick_next_tool(ctx, results, called, first, options, errors):
    if is_real_llm_configured() and not options.get("forceRuleTools"):
        try:
            budget = options.get("budget")
            if budget:
                budget.assert_can_call_llm()
            llm = await llm_pick_tool(ctx, results, called, budget)
            if budget:
                budget.record_llm_call()
            if llm is None:
                return None
            if llm is not False and llm["tool"] not in called:
                return {**llm, "source": "agent"}
        except Exception as e:
            errors.append(str(e))
    rule = rule_pick_tool(ctx, results, called, first)
    if not rule or rule["tool"] in called:
        return None
    return {**rule, "source": "rule"}


def should_stop_after(question, results, scope=None):
    q = question.lower()
    has_compare = any(r.get("ok") and r.get("tool") == "compare_campaigns" for r in results)
    has_metrics = any(r.get("ok") and r.get("tool") == "get_campaign_metrics" for r in results)
    if re.search(r"creative|素材|budget|预算", q) and has_compare and not has_metrics:
        return False
    if scope in ("account", "comparison"):
        return has_compare
    if re.search(r"other campaign|同样|same pattern|campaign d|相比", q):
        return True
    if re.search(r"particular day|哪一天|daily|趋势|trend", q):
        return len(results) >= 2
    return len(results) >= 2


async def run_investigation_agent(ctx: dict, options: dict | None = None) -> dict:
    options = options or {}
    results: list[dict] = []
    steps: list[dict] = []
    status_trail: list[str] = []
    called: set[str] = set()
    tool_selection_errors: list[str] = []
    llm_picks = 0
    rule_picks = 0
    llm_configured = is_real_llm_configured() and not options.get("forceRuleTools")

    for round_i in range(MAX_CALLS):
        nxt = await pick_next_tool(ctx, results, called, round_i == 0, options, tool_selection_errors)
        if not nxt:
            break
        if nxt["tool"] in called:
            break
        called.add(nxt["tool"])
        status_trail.append(STATUS_LABEL[nxt["tool"]])
        result = execute_tool(nxt, ctx)
        results.append(result)
        steps.append(
            {
                "tool": nxt["tool"],
                "label": TOOL_LABEL[nxt["tool"]],
                "ok": result.get("ok"),
                "summary": summarize_tool(result) if result.get("ok") else result.get("message"),
                "picker": "llm" if nxt.get("source") == "agent" else "rule",
            }
        )
        if not result.get("ok") and nxt["tool"] in ("get_campaign_metrics", "compare_campaigns"):
            break
        if should_stop_after(ctx["question"], results, ctx.get("scope")):
            break
        if nxt.get("source") == "agent":
            llm_picks += 1
        elif llm_configured:
            rule_picks += 1

    tool_selection = "llm" if llm_picks else ("llm_fallback" if llm_configured and rule_picks else "rule")
    return {
        "results": results,
        "steps": steps,
        "mode": "agent" if llm_picks else "rule",
        "statusTrail": status_trail,
        "toolSelection": tool_selection,
        "toolSelectionErrors": tool_selection_errors,
    }


def tool_plan_for_question(question: str, ctx: dict) -> list:
    called: set[str] = set()
    planned: list[dict] = []
    simulated: list[dict] = []
    for i in range(MAX_CALLS):
        nxt = rule_pick_tool(ctx, simulated, called, i == 0)
        if not nxt or nxt["tool"] in called:
            break
        called.add(nxt["tool"])
        planned.append(nxt)
        simulated.append({"ok": True, "tool": nxt["tool"]})
    return planned

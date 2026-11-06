from __future__ import annotations

import re

from app.services.copilot.issue_titles import issue_title_for_finding
from app.services.copilot.labels import FINDING_LABEL, format_count, format_rate


def attach_presentation(investigation: dict, input_data: dict) -> dict:
    return {**investigation, "presentation": build_presentation(investigation, input_data)}


def build_presentation(investigation: dict, input_data: dict) -> dict:
    metrics = next((r for r in input_data.get("results", []) if r.get("ok") and r.get("tool") == "get_campaign_metrics"), None)
    chips: list[dict] = []
    if metrics and metrics.get("ok") and metrics.get("tool") == "get_campaign_metrics":
        for key in ("clicks", "conversions", "cvr"):
            row = next((m for m in metrics.get("metrics", []) if m.get("key") == key), None)
            if row and row.get("status") == "ok":
                chips.append(metric_chip(row))
        if re.search(r"ctr", input_data.get("question", ""), re.I):
            ctr = next((m for m in metrics.get("metrics", []) if m.get("key") == "ctr"), None)
            if ctr and ctr.get("status") == "ok":
                chips.append(metric_chip(ctr))
    elif input_data.get("finding"):
        finding = input_data["finding"]
        chips = [
            {"label": "Clicks", "value": format_count(finding["raw"]["clicks"])},
            {"label": "Conversion-linked clicks", "value": format_count(finding["raw"]["conversions"])},
            {"label": "Post-click conversion-link rate", "value": format_rate(finding["raw"]["cvr"])},
        ]

    finding = input_data.get("finding")
    lead = (input_data.get("answerLead") or "").strip()
    if lead:
        finding_line = lead
    elif finding:
        finding_line = f"{issue_title_for_finding(finding)} for {finding['campaignName']} in {finding['windowLabel']}."
    else:
        finding_line = "Investigation summary for the selected campaign."

    explanations = investigation.get("explanations") or []
    interpretation = next((item for item in explanations if not re.search(r"hypothesis only", item, re.I)), None)
    if not interpretation:
        interpretation = explanations[0] if explanations else (
            "Patterns in traffic mix or reporting definitions may still explain part of the movement. "
            "None of these are verified root causes."
        )

    limitations = (investigation.get("cannotDetermine") or [])[:4]
    actions = build_actions(input_data.get("kind"), input_data.get("hasComparison"), finding)
    trend = next((r for r in input_data.get("results", []) if r.get("ok") and r.get("tool") == "analyze_daily_trend"), None)
    full = input_data.get("kind") in ("performance", "comparison", "daily_trend", "next_steps", "account_attention")

    window_label = metrics["windowLabel"] if metrics and metrics.get("ok") else (finding.get("windowLabel") if finding else None)
    compare_label = metrics["compareLabel"] if metrics and metrics.get("ok") else (finding.get("compareLabel") if finding else None)

    return {
        "finding": re.sub(r"\s+", " ", finding_line)[:420],
        "metrics": chips,
        "interpretation": interpretation,
        "limitations": limitations,
        "nextStep": (investigation.get("nextSteps") or [None])[0],
        "structure": "full" if full else "simple",
        "actions": actions,
        "windowLabel": window_label,
        "compareLabel": compare_label,
        "currentStart": trend.get("currentStart") if trend else None,
        "currentEnd": trend.get("currentEnd") if trend else None,
        "compareStart": trend.get("compareStart") if trend else None,
        "compareEnd": trend.get("compareEnd") if trend else None,
        "formulaNote": (
            "Post-click conversion-link rate = conversion-labeled click rows ÷ click rows, grouped by impression date. "
            "It is not a unique conversion-event rate."
        ),
    }


def metric_chip(metric: dict) -> dict:
    labels = {
        "clicks": "Clicks",
        "conversions": "Conversion-linked clicks",
        "cvr": "Post-click conversion-link rate",
        "ctr": "CTR",
        "cost": "Cost index per click",
    }
    if metric.get("key") in ("cvr", "ctr"):
        value = format_rate(metric.get("current"))
    else:
        value = format_count(metric.get("current"))
    detail = None
    if metric.get("previous") is not None and metric.get("status") == "ok":
        if metric.get("key") in ("cvr", "ctr"):
            prev = format_rate(metric.get("previous"))
        else:
            prev = format_count(metric.get("previous"))
        rel = metric.get("relativePct")
        if rel is None:
            rel_text = "no relative change"
        elif rel > 0:
            rel_text = f"+{rel:.1f}% vs prior window"
        else:
            rel_text = f"{rel:.1f}% vs prior window"
        detail = f"{prev} → {value} ({rel_text})"
    return {"label": labels.get(metric.get("key"), metric.get("label")), "value": value, **({"detail": detail} if detail else {})}


def build_actions(kind: str | None, has_comparison: bool | None, finding: dict | None) -> list[dict]:
    actions: list[dict] = [
        {"id": "view_trend", "label": "View daily trend", "question": "Show me the daily trend."},
        {"id": "inspect_evidence", "label": "Inspect supporting data"},
    ]
    if not has_comparison:
        actions.insert(
            0,
            {
                "id": "compare_periods",
                "label": "Compare periods",
                "question": "How does this window compare to the prior period?",
            },
        )
    else:
        actions.append(
            {
                "id": "compare_periods",
                "label": "Compare campaigns",
                "question": "Does another campaign show the same pattern?",
            }
        )
    if kind == "unsupported":
        actions.insert(
            0,
            {
                "id": "send_question",
                "label": "What data is missing?",
                "question": "What should we verify next given the available fields?",
            },
        )
    if finding and finding.get("recommendation"):
        actions.append({"id": "decision_brief", "label": "Create decision brief"})
    else:
        actions.append({"id": "decision_brief", "label": "Prepare recommendation"})
    if finding and not finding.get("recommendation"):
        actions.append(
            {"id": "send_question", "label": "Next verification", "question": "What should we verify next?"}
        )
    return actions


def performance_finding_lead(name: str, has_comparison: bool, cvr_metric: dict | None, finding: dict | None) -> str:
    if not has_comparison or not cvr_metric or cvr_metric.get("status") != "ok":
        suffix = ", but no comparison period is selected in this window." if not (finding or {}).get("compareLabel") else ""
        current = cvr_metric.get("current") if cvr_metric else (finding or {}).get("raw", {}).get("cvr")
        return f"A decline has not been established yet for {name}. Post-click conversion-link rate is {format_rate(current)}{suffix}"
    rel = cvr_metric.get("relativePct")
    if rel is None:
        rel_text = "no relative change"
    elif rel > 0:
        rel_text = f"+{rel:.1f}% vs the prior window"
    else:
        rel_text = f"{rel:.1f}% vs the prior window"
    signal = issue_title_for_finding(finding) if finding else FINDING_LABEL["cvr_anomaly"]
    return (
        f"{signal}: post-click conversion-link rate moved {rel_text} "
        f"({format_rate(cvr_metric.get('previous'))} → {format_rate(cvr_metric.get('current'))}). "
        "This is an observed change in conversion-labeled clicks, not a verified root cause or a unique conversion-event count."
    )

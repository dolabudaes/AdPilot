from __future__ import annotations

import json
import re
from typing import Any


def compile_investigation_packet(context: dict, messages: list[dict] | None = None) -> dict:
    completed = [item for item in (messages or []) if item.get("status") != "failed"]
    tools: list[str] = []
    for item in completed:
        tools.extend(item.get("tools") or [])
    text = "\n".join(item.get("content") or "" for item in completed)
    daily = "analyze_daily_trend" in tools
    compared = "compare_campaigns" in tools
    metrics_reviewed = "get_campaign_metrics" in tools or any(
        item.get("role") == "assistant" and (item.get("content") or "").strip() for item in completed
    )
    creative_checked = any(re.search(r"creative", item.get("content") or "", re.I) for item in completed) and bool(
        re.search(r"cannot be verified|no creative|not in this dataset", text, re.I)
    )
    review_ready = any(item.get("reviewReady") for item in completed) or bool(
        re.search(r"create a (?:review )?decision|human-review recommendation", text, re.I)
    )
    peer = first_peer(context.get("campaignName") or "", text) if compared else None
    priority_peer = (
        peer
        if peer and re.search(r"first human review|review first|highest-ranked|more severe|declined more", text, re.I)
        else None
    )
    validation_task = is_improvement(context)
    decline_review = is_decline(context)
    prioritize = bool(priority_peer) or (decline_review and context.get("severity") == "high" and compared)
    action = action_headline(context, validation_task, decline_review, prioritize)
    reason = rationale(
        context,
        {
            "validationTask": validation_task,
            "declineReview": decline_review,
            "daily": daily,
            "compared": compared,
            "peer": peer,
            "priorityPeer": priority_peer,
            "creativeChecked": creative_checked,
        },
    )
    verification = verification_items(context, {"validationTask": validation_task, "declineReview": decline_review, "daily": daily})
    trail = trail_steps(
        context,
        {
            "metricsReviewed": metrics_reviewed,
            "daily": daily,
            "compared": compared,
            "creativeChecked": creative_checked,
            "reviewReady": review_ready,
        },
    )
    return {
        "title": action,
        "action": action,
        "reason": reason,
        "verificationSteps": verification,
        "trail": trail,
        "peer": peer,
        "priorityPeer": priority_peer,
        "daily": daily,
        "compared": compared,
        "creativeChecked": creative_checked,
        "reviewReady": review_ready,
    }


def action_headline(context: dict, validation_task: bool, decline_review: bool, prioritize: bool) -> str:
    name = context.get("campaignName") or "this campaign"
    if validation_task:
        return f"Validate {name}'s conversion-link improvement before scaling"
    if decline_review and prioritize:
        return f"Prioritize {name}: verify setup before any delivery change"
    if decline_review and context.get("severity") == "high":
        return f"Verify {name} before changing delivery"
    if decline_review:
        return f"Verify {name}'s conversion-link decline before changing delivery"
    finding_type = context.get("findingType")
    if finding_type == "cost_rise":
        return f"Review {name}'s cost-index increase"
    if finding_type == "weak_click_efficiency":
        return f"Review {name}'s weak click efficiency"
    if finding_type == "attribution_anomaly":
        return f"Review {name}'s attribution change"
    if finding_type == "data_gap":
        return f"Review {name}'s incomplete measurement"
    return f"Review {name}"


def rationale(context: dict, trail: dict) -> str:
    name = context.get("campaignName") or "This campaign"
    evidence = context.get("evidence") or []
    rate = find_evidence(evidence, ["post-click conversion-link rate", "conversion-link rate", "post-click cvr"])
    clicks = find_evidence(evidence, ["clicks"])
    linked = find_evidence(evidence, ["conversion-linked clicks", "conversions"])
    rate_dir = direction(rate)
    click_dir = direction(clicks)
    linked_dir = direction(linked)
    sentences: list[str] = []
    if trail["validationTask"]:
        sentences.append(
            "The conversion-link rate improved substantially, but this alone does not demonstrate that increasing delivery or budget would improve outcomes."
        )
    elif trail["declineReview"]:
        if click_dir == "up" and (rate_dir == "down" or linked_dir == "down"):
            sentences.append(
                f"{name}'s conversion-link rate declined even as click volume increased, and conversion-linked clicks did not keep pace."
            )
        elif rate_dir == "down":
            sentences.append("The conversion-link rate declined from the previous window.")
        else:
            sentences.append("The saved conversion-link evidence supports a human review of this campaign.")
        window = (context.get("windowLabel") or "").strip() or "this analysis window"
        if trail["creativeChecked"]:
            sentences.append("A creative-change hypothesis was considered and could not be verified from this dataset.")
        else:
            sentences.append(
                f"Next: verify creative, landing-page, audience, budget, and tracking in the ad platform for {window} before changing delivery."
            )
        if trail["priorityPeer"]:
            sentences.append(
                f"A same-window comparison found {name}'s decline more severe than {trail['priorityPeer']}'s, so it is the higher-priority case for investigation."
            )
        elif trail["compared"] and trail["peer"]:
            sentences.append(
                f"A same-window comparison with {trail['peer']} was completed; it does not establish a shared cause."
            )
        elif context.get("severity") == "high":
            sentences.append("This is a high-priority investigation signal, but the available data does not establish the underlying cause.")
        elif context.get("severity") == "medium":
            sentences.append(
                "The movement meets the medium-priority review criteria. Further investigation is warranted before drawing conclusions about its cause."
            )
    elif context.get("findingType") == "cost_rise":
        sentences.append("The cost index moved higher. Cost here is an index, not verified spend, so the next step is review rather than a bid change.")
    else:
        sentences.append("The saved metrics support a human review. They do not identify a delivery change to make.")
    if trail["daily"] and len(sentences) < 3 and not trail["validationTask"] and not trail["creativeChecked"]:
        sentences.append("Daily observations were reviewed; the cause is still unverified.")
    elif len(sentences) < 2:
        sentences.append("The available data does not establish the underlying cause.")
    return " ".join(sentences[:3])


def verification_items(context: dict, trail: dict) -> list[str]:
    items: list[str] = []
    window = (context.get("windowLabel") or "").strip() or "this analysis window"
    name = context.get("campaignName") or "this campaign"
    if trail["validationTask"]:
        items.append(f"First confirm whether {name}'s conversion-link improvement in {window} holds across days.")
        items.append("Then check creative, landing page, audience, budget, and bids in the advertising platform. Those fields are not in this snapshot.")
        items.append("Only after the improvement is verified outside this log should delivery or budget be considered.")
    elif trail["declineReview"]:
        items.append(f"First check whether {name} had creative, landing-page, or audience changes in {window}. Those fields are not in this snapshot.")
        items.append("Then inspect budget, bids, and delivery structure for the same window.")
        items.append(
            "Only after tracking, attribution-window, and measurement issues are ruled out, consider a delivery change."
            if trail["daily"]
            else "Check whether the conversion-link decline persists across days, then consider a delivery change only after measurement issues are ruled out."
        )
    else:
        if not trail["daily"]:
            items.append("Check whether the change persists across daily observations.")
        items.append("Review creative, audience, budget, and bid history in the advertising platform.")
        items.append("Do not change delivery until tracking and measurement questions are resolved.")
    seen = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen[:3]


def trail_steps(context: dict, flags: dict) -> list[dict]:
    source = {
        "conversationId": context.get("conversationId"),
        "windowId": context.get("windowId"),
        "datasetVersion": context.get("datasetVersion"),
    }
    steps = []
    if flags["metricsReviewed"]:
        steps.append({"id": "signal", "label": "Initial signal reviewed", "tools": ["get_campaign_metrics"], **source})
    if flags["daily"]:
        steps.append({"id": "daily", "label": "Daily trend inspected", "tools": ["analyze_daily_trend"], **source})
    if flags["compared"]:
        steps.append({"id": "compare", "label": "Campaign comparison completed", "tools": ["compare_campaigns"], **source})
    if flags["creativeChecked"]:
        steps.append({"id": "creative", "label": "Creative-change hypothesis considered", "tools": ["get_campaign_metrics"], **source})
    if flags["reviewReady"]:
        steps.append({"id": "recommend", "label": "Review recommendation generated", "tools": [], **source})
    return steps


def first_peer(campaign_name: str, text: str) -> str | None:
    names = [match.group(0) for match in re.finditer(r"Campaign\s+[A-Z0-9]+", text) if match.group(0) != campaign_name]
    return next(iter(dict.fromkeys(names)), None)


def is_improvement(context: dict) -> bool:
    title = str(context.get("title") or "")
    return (
        context.get("findingType") == "scale_opportunity"
        or context.get("actionType") == "increase_priority"
        or bool(re.search(r"validate(?: observed)? conversion-link improvement|increase priority", title, re.I))
    )


def is_decline(context: dict) -> bool:
    title = str(context.get("title") or "")
    return context.get("findingType") in ("cvr_anomaly", "cost_rise") or bool(
        re.search(r"conversion-link rate decline|conversion-efficiency decline|conversion efficiency decline|efficiency decline", title, re.I)
    )


def find_evidence(evidence: list[dict], labels: list[str]) -> dict | None:
    for item in evidence:
        label = str(item.get("label") or "").lower()
        if any(needle == label or needle in label for needle in labels):
            return item
    return None


def direction(item: dict | None) -> str | None:
    if not item:
        return None
    current = parse_number(item.get("value"))
    previous = parse_number(item.get("baseline"))
    if current is None or previous is None:
        delta = str(item.get("delta") or "").strip()
        if delta.startswith("-"):
            return "down"
        if delta.startswith("+"):
            return "up"
        return None
    if current > previous:
        return "up"
    if current < previous:
        return "down"
    return "flat"


def parse_number(value: Any) -> float | None:
    if value is None:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", str(value).replace(",", ""))
    return float(match.group(0)) if match else None


def messages_from_conversation(db, conversation_id: str) -> list[dict]:
    try:
        rows = db.execute(
            "SELECT role, content, status, evidence_json, review_ready FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        ).fetchall()
    except Exception:
        rows = db.execute(
            "SELECT role, content, status, evidence_json FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        ).fetchall()
    out = []
    for row in rows:
        payload = {}
        raw = row["evidence_json"] if "evidence_json" in row.keys() else None
        if raw:
            try:
                parsed = json.loads(raw)
                payload = parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                payload = {}
        review = row["review_ready"] if "review_ready" in row.keys() else 0
        out.append(
            {
                "role": row["role"],
                "content": row["content"],
                "status": row["status"],
                "tools": payload.get("tools") or [],
                "reviewReady": bool(review or payload.get("reviewReady") or payload.get("review_ready")),
            }
        )
    return out

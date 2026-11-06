from __future__ import annotations

import re

from app.services.copilot.labels import (
    ACTION_LABEL,
    EVIDENCE_LABEL,
    FINDING_LABEL,
    SEVERITY_LABEL,
    STATUS_LABEL,
    format_change,
    format_count,
    format_rate,
)

UNCERTAINTY = (
    "Numbers come from deterministic calculations for the current window. "
    "Budget, bids, creatives, landing pages, and post-execution outcomes are not in the data."
)

_EVIDENCE_CLICK_LABELS = ("Clicks", "Post-click conversion-link rate")
_COST_INDEX_LABEL = "Cost index"
_NO_COMPARISON = "No comparison"


def answer_question(model: dict, question: str, finding_id: str | None = None) -> dict:
    text = question.strip()
    finding = next((f for f in model.get("findings", []) if f["id"] == finding_id), None)
    if not model.get("ready"):
        return pack(model["briefing"]["summary"], "chat")
    if not finding:
        return pack(
            "Select a campaign issue first. Answers use that issue's window and metrics.",
            "chat",
        )
    intent = intent_of(text)
    if intent == "execute":
        return pack(
            "I cannot apply delivery changes. Approval, export, and external marking are separate steps; "
            "this conversation does not write to an ad platform.",
            "chat",
        )
    if intent == "review":
        return review_answer(finding)
    if intent == "diff":
        return diff_answer(finding)
    if intent == "conservative":
        return conservative_answer(finding)
    if intent == "missing":
        return missing_answer(finding, model)
    if intent == "evidence":
        return evidence_answer(finding)
    if intent == "priority":
        return priority_answer(finding)
    if intent == "hold":
        return hold_answer(finding)
    if intent == "pause":
        return pause_answer(finding)
    if intent == "why":
        return why_answer(finding)
    return pack(f"{finding['campaignName']}: {finding['interpretation']}", "chat", evidence_from(finding)[:2])


def intent_of(text: str) -> str:
    q = text.lower()
    if re.search(r"执行|改预算|直接暂停|execute|change the budget", q):
        return "execute"
    if re.search(r"审批|审核|human review|prepare this|for review", q):
        return "review"
    if re.search(r"差异|差别|不同|original proposal|different from|对比原", q):
        return "diff"
    if re.search(r"保守|更稳|conservative|safer", q):
        return "conservative"
    if re.search(r"还缺|缺少|additional evidence|what .*evidence|do we need|不确定|uncertainty|核验", q):
        return "missing"
    if re.search(r"证据|依据|哪些数据|evidence|来源", q):
        return "evidence"
    if re.search(r"优先级|priority", q):
        return "priority"
    if re.search(r"不调整|不改|leave unchanged|维持|会怎样", q):
        return "hold"
    if re.search(r"暂停|pause", q) and not re.search(r"为什么|why", q):
        return "pause"
    if re.search(r"为什么|为何|why|decline|下降|转化", q):
        return "why"
    return "chat"


def why_answer(finding: dict) -> dict:
    pattern = read_pattern(finding)
    confirmed = moved_facts(finding)
    if pattern["clicksUp"] and pattern["conversionsDown"]:
        answer = (
            f"{finding['campaignName']} is gaining clicks while conversion-linked clicks and "
            f"post-click conversion-link rate are falling. "
            "That is what the comparison window already shows—it is not yet a root cause."
        )
    else:
        answer = (
            f"{finding['campaignName']} is flagged for {FINDING_LABEL.get(finding['type'], finding['type'])}. "
            "Below are only the metrics that actually moved in this comparison."
        )
    return pack(
        answer,
        "investigation",
        evidence_from(finding),
        None,
        None,
        [
            {"title": "Confirmed", "items": confirmed},
            {"title": "Possible explanations", "items": hypotheses_for(finding, pattern)},
            {"title": "Not yet confirmed", "items": gaps_for(pattern)},
            {"title": "Next steps", "items": checks_for(finding, pattern)},
            {"title": "Actions to consider", "items": [action_line(finding)]},
        ],
    )


def missing_answer(finding: dict, model: dict) -> dict:
    pattern = read_pattern(finding)
    return pack(
        f"The available fields cannot explain a root cause for {finding['campaignName']}. "
        "What is missing is data that could falsify the hypotheses below—not another metric summary.",
        "investigation",
        [],
        " ".join(model.get("missing") or []),
        None,
        [
            {"title": "Not yet confirmed", "items": [*gaps_for(pattern), *(model.get("missing") or [])]},
            {"title": "Suggested checks", "items": checks_for(finding, pattern)},
        ],
    )


def evidence_answer(finding: dict) -> dict:
    compare = f", compared with {finding['compareLabel']}" if finding.get("compareLabel") else ""
    return pack(
        f"These numbers come from {finding['windowLabel']}{compare}. Click a row to locate it in the evidence panel.",
        "metrics",
        evidence_from(finding),
    )


def priority_answer(finding: dict) -> dict:
    rec_evidence = (
        EVIDENCE_LABEL[finding["recommendation"]["proposal"]["evidenceLevel"]]
        if finding.get("recommendation")
        else "No recommendation yet"
    )
    return pack(
        f"{finding['campaignName']} is marked {SEVERITY_LABEL.get(finding['severity'], finding['severity'])} priority "
        "because magnitude and click sample both crossed the threshold—not because every decline enters the queue.",
        "metrics",
        [e for e in evidence_from(finding) if e["label"] in _EVIDENCE_CLICK_LABELS],
        None,
        None,
        [
            {
                "title": "Assessment",
                "items": [
                    f"Type: {FINDING_LABEL.get(finding['type'], finding['type'])}",
                    f"Clicks {format_count(finding['raw']['clicks'])}, comparison {format_count(finding['raw']['previousClicks'])}",
                    f"Post-click conversion-link rate {format_rate(finding['raw']['cvr'])}, change {format_change(finding['raw']['cvrChangePct'])}",
                    rec_evidence,
                ],
            }
        ],
    )


def conservative_answer(finding: dict) -> dict:
    revision = conservative_revision(finding)
    if not revision:
        return pack("There is no recommendation left to tighten further.", "chat")
    prop = finding["recommendation"]["proposal"]
    return pack(
        f"A safer candidate is to change {ACTION_LABEL[prop['actionType']]} to {ACTION_LABEL[revision['actionType']]}. "
        "This is only a candidate; saving moves it to draft and does not auto-submit for review.",
        "proposal",
        [],
        None,
        revision,
        [
            {
                "title": "Tradeoffs",
                "items": [
                    "This candidate does not change live delivery settings.",
                    "It cannot estimate how many conversion-linked clicks might be spared—there is no post-execution data.",
                ],
            }
        ],
    )


def diff_answer(finding: dict) -> dict:
    current = finding.get("recommendation")
    if not current:
        return pack("This issue has no proposal to compare yet.", "chat")
    revision = conservative_revision(finding)
    original = ACTION_LABEL[current["original"]["actionType"]]
    saved = ACTION_LABEL[current["proposal"]["actionType"]]
    candidate = ACTION_LABEL[revision["actionType"]] if revision else saved
    if current.get("userEdited"):
        answer = (
            f"The saved proposal is {saved}; the original rule suggestion was {original}. "
            f"Review status is still {current['status']}; this conversation did not change it."
        )
    else:
        answer = (
            f"The original rule suggestion was {original}. With the safer candidate, the action would become {candidate}. "
            f"Nothing is saved yet, so the formal proposal is still {saved}."
        )
    return pack(
        answer,
        "diff",
        [],
        None,
        revision if revision and not current.get("userEdited") else None,
        [
            {
                "title": "Comparison",
                "items": [
                    f"Original suggestion: {original}",
                    f"Current formal proposal: {saved}{' (edited)' if current.get('userEdited') else ''}",
                    f"Safer candidate: {candidate}",
                    "The difference is action strength, not metrics. Metrics were not recomputed.",
                ],
            }
        ],
    )


def review_answer(finding: dict) -> dict:
    proposal = finding.get("recommendation")
    if not proposal:
        return pack("This issue has no recommendation ready to submit.", "chat")
    ready = proposal["status"] == "draft" and proposal["proposal"]["guardrail"]["passed"]
    if ready:
        answer = (
            f"You can submit «{ACTION_LABEL[proposal['proposal']['actionType']]}». "
            "What follows is a review summary only; confirming moves it to pending review."
        )
    else:
        answer = (
            f"Current status is {STATUS_LABEL.get(proposal['status'], proposal['status'])}. "
            "This conversation cannot auto-submit a recommendation that was already processed."
        )
    return pack(
        answer,
        "review",
        evidence_from(finding)[:3],
        proposal["proposal"]["riskNote"],
        None,
        [
            {
                "title": "Review summary",
                "items": [
                    finding["interpretation"],
                    f"Action: {ACTION_LABEL[proposal['proposal']['actionType']]}",
                    proposal["proposal"]["riskNote"],
                    "Approval is not execution, and nothing is written to a platform.",
                ],
            }
        ],
        ready,
    )


def hold_answer(finding: dict) -> dict:
    revision = None
    if finding.get("recommendation"):
        revision = {
            "actionType": "hold",
            "reason": f"Continue monitoring {finding['campaignName']} without changing priority.",
            "label": "Save as continue monitoring",
        }
    return pack(
        f"You can leave {finding['campaignName']} unchanged. The observed differences remain, "
        "but there is no estimate of what leaving it unchanged would cost.",
        "proposal",
        [],
        None,
        revision,
    )


def pause_answer(finding: dict) -> dict:
    action = finding.get("recommendation", {}).get("proposal", {}).get("actionType")
    if action == "pause_candidate":
        return pack(
            f"{finding['campaignName']} is marked for review before pausing based on post-click conversion-link rate "
            f"{format_change(finding['raw']['cvrChangePct'])} and {format_count(finding['raw']['clicks'])} clicks. "
            "This is not an executed pause.",
            "proposal",
            [e for e in evidence_from(finding) if e["label"] in _EVIDENCE_CLICK_LABELS],
            None,
            {
                "actionType": "review",
                "reason": f"Run manual review on {finding['campaignName']} instead of entering pause candidacy.",
                "label": "Change to manual review",
            },
        )
    action_label = ACTION_LABEL[action] if action else "No action generated"
    return pack(
        f"{finding['campaignName']} did not meet the threshold for review before pausing. "
        f"The current suggestion is {action_label}.",
        "chat",
    )


def read_pattern(finding: dict) -> dict:
    raw = finding.get("raw") or {}
    return {
        "clicksUp": (raw.get("clicksChangePct") or 0) > 0,
        "conversionsDown": (raw.get("conversionDelta") or 0) < 0,
        "cvrDown": (raw.get("cvrChangePct") or 0) < 0,
        "costUp": (raw.get("costPerClickChangePct") or 0) > 0,
    }


def hypotheses_for(finding: dict, pattern: dict) -> list[str]:
    if finding.get("type") == "cost_rise" or (pattern["costUp"] and not pattern["cvrDown"]):
        return [
            "Cost index per click rose, but that is not ad spend. Without budget and bid fields, "
            "you cannot conclude price or budget changes caused it."
        ]
    if finding.get("type") == "scale_opportunity":
        return [
            "Post-click conversion-link rate is above its own comparison. "
            "That supports validating whether the improvement is sustained, not increasing budget, bids, or advertising-platform priority."
        ]
    if finding.get("type") == "attribution_anomaly":
        return [
            "Attribution-link share shifted. That is mix structure, not proof that conversion events fell. "
            "Finer attribution paths are not available."
        ]
    if pattern["clicksUp"] and pattern["conversionsDown"]:
        return [
            "New clicks may not be converting at the same rate. Without audience or placement splits, "
            "traffic composition cannot be confirmed.",
            "Conversion records in the later window may be incomplete. Only totals exist—you cannot separate "
            "missing events from missing logging.",
            "Landing pages or creatives after the click may have changed. Those fields are absent, "
            "so this cannot be stated as a verified cause.",
        ]
    if pattern["cvrDown"]:
        return [
            "Post-click conversion-link rate is below its comparison while conversion-linked clicks also fell. "
            "Without breakdowns, the decline cannot be tied to a single traffic source."
        ]
    return [finding.get("hypothesis") or ""]


def gaps_for(pattern: dict) -> list[str]:
    gaps = ["Budget, bid, and verified spend are unavailable, so budget or bid conclusions are out of scope."]
    if pattern["clicksUp"]:
        gaps.append(
            "Audience, placement, and creative splits are unavailable, so extra clicks cannot be traced to a segment."
        )
    if pattern["conversionsDown"] or pattern["cvrDown"]:
        gaps.append(
            "Conversion detail and landing-page data are unavailable, so missing conversion-linked clicks cannot be split "
            "between events that did not happen and events that were not recorded."
        )
    return gaps


def checks_for(finding: dict, pattern: dict) -> list[str]:
    checks = [
        f"On the investigation page, check whether daily clicks and conversion-linked clicks for {finding['campaignName']} "
        "moved in opposite directions on the same days."
    ]
    if pattern["clicksUp"] and pattern["conversionsDown"]:
        checks.append(
            "If audience or creative data arrives later, verify whether new clicks came from historically weaker slices. "
            "That check is not possible with the current dataset."
        )
    if pattern["costUp"]:
        checks.append(
            "Keep cost index separate from real spend. Only the index is visible—it must not be rewritten as rising spend."
        )
    checks.append(
        "Sample and magnitude are enough to flag an issue, but not enough to name a single confirmed root cause."
    )
    return checks


def action_line(finding: dict) -> str:
    if not finding.get("recommendation"):
        return "Sample or magnitude was insufficient to generate a candidate action."
    return (
        f"The rule candidate is {ACTION_LABEL[finding['recommendation']['proposal']['actionType']]}. "
        "It is evidence-bound—not a confirmed cause—and has not passed human review."
    )


def conservative_revision(finding: dict) -> dict | None:
    action = finding.get("recommendation", {}).get("proposal", {}).get("actionType")
    if not action:
        return None
    if action in ("pause_candidate", "decrease_priority", "increase_priority"):
        next_action = "review"
    else:
        next_action = "hold"
    if next_action == action:
        return None
    return {
        "actionType": next_action,
        "reason": (
            f"Use {ACTION_LABEL[next_action]} for {finding['campaignName']} instead of {ACTION_LABEL[action]}."
        ),
        "label": f"Save as {ACTION_LABEL[next_action]}",
    }


def moved_facts(finding: dict) -> list[str]:
    rows = [
        item
        for item in finding.get("evidence", [])
        if item.get("delta") and item["delta"] not in (_NO_COMPARISON, "0.0%", "+0.0%")
    ]
    source = rows if rows else finding.get("evidence", [])
    out = []
    for item in source:
        baseline = item.get("baseline") or "n/a"
        delta = item.get("delta") or "n/a"
        if item.get("label") == _COST_INDEX_LABEL:
            out.append(
                f"Cost index: current {item['value']}, comparison {baseline}. "
                f"{delta} is the change in cost index per click—not a ratio of these totals and not ad spend."
            )
        else:
            out.append(f"{item['label']}: current {item['value']}, comparison {baseline}, change {delta}")
    return out


def pack(
    answer: str,
    kind: str,
    evidence: list | None = None,
    uncertainty: str | None = UNCERTAINTY,
    revision: dict | None = None,
    sections: list | None = None,
    review_ready: bool = False,
) -> dict:
    return {
        "answer": answer,
        "kind": kind,
        "evidence": evidence or [],
        "uncertainty": uncertainty or UNCERTAINTY,
        "revision": revision,
        "sections": sections or [],
        "reviewReady": review_ready,
    }


def evidence_from(finding: dict | None) -> list[dict]:
    if not finding:
        return []
    return [{"label": e["label"], "value": e["value"], "source": e["source"]} for e in finding.get("evidence", [])[:4]]

from __future__ import annotations

from app.services.copilot.labels import ACTION_LABEL, EVIDENCE_LABEL
from app.services.copilot.proposal_consistency import proposal_consistency_issue
from app.services.guardrails.validate_strategy import validate_strategy
from app.services.simulation import simulate_strategy


def propose(finding: dict, override: dict | None = None) -> dict | None:
    override = override or {}
    if finding["type"] == "data_gap" or finding["severity"] == "info":
        return None
    action = override.get("actionType") or choose_action(finding)
    reason = (override.get("reason") or default_reason(finding)).strip()
    first = assemble(finding, action, reason)
    if first["guardrail"]["passed"] or action == "review":
        return first
    fallback = assemble(
        finding,
        "review",
        f"{reason} The original action did not pass the guardrail, so it was changed to manual review.",
    )
    fallback["guardrail"]["warnings"] = [
        *fallback["guardrail"].get("warnings", []),
        "The original action did not pass the guardrail and was changed to manual review.",
    ]
    return fallback


def choose_action(finding: dict) -> str:
    return "review"


def default_reason(finding: dict) -> str:
    return f"{finding['fact']}{finding['interpretation']}"


def default_verification_steps(finding: dict) -> str:
    window = finding.get("windowLabel") or "the selected window"
    name = finding.get("campaignName") or "this campaign"
    if finding.get("type") == "scale_opportunity":
        return "\n".join(
            [
                f"First confirm whether {name}'s conversion-link improvement in {window} holds across days.",
                "Then check creative, landing page, audience, budget, and bids in the advertising platform. Those fields are not in this snapshot.",
                "Only after the improvement is verified outside this log should delivery or budget be considered.",
            ]
        )
    return "\n".join(
        [
            f"First check whether {name} had creative, landing-page, or audience changes in {window}. Those fields are not in this snapshot.",
            "Then inspect budget, bids, and delivery structure for the same window.",
            "Only after tracking, attribution-window, and measurement issues are ruled out, consider a delivery change.",
        ]
    )


def assemble(finding: dict, action: str, reason: str) -> dict:
    evidence_level = level_for(finding)
    risk_level = risk_for(action)
    guarded = guard(finding, action, reason, evidence_level)
    return {
        "title": proposal_title(finding, action),
        "actionType": action,
        "reason": reason,
        "currentState": f"No budget or bid field is available. Verified observation: {finding['raw']['clicks']} clicks, post-click conversion-link rate from processed data, versus the prior window.",
        "proposedState": f"Proposed action: {ACTION_LABEL[action]}. Confirmation still requires an export or an external platform action; AdPilot does not change campaign delivery directly.",
        "impact": f"Scope is limited to {finding['campaignName']}.",
        "riskLevel": risk_level,
        "riskNote": risk_note(action, finding),
        "evidenceLevel": evidence_level,
        "evidence": finding["evidence"],
        "guardrail": guarded,
        "offlineComparison": comparison(finding["campaignId"], action),
        "expectedEffect": None,
        "expectedEffectNote": "No reliable outcome estimate is available. Offline weighting only compares directions in historical logs; it is not a forecast of platform results.",
    }


def proposal_title(finding: dict, action: str) -> str:
    if action != "review":
        return f"{finding['campaignName']}: {ACTION_LABEL[action]}"
    type_titles = {
        "cvr_anomaly": "Verify setup before changing delivery",
        "scale_opportunity": "Validate observed conversion-link improvement",
        "cost_rise": "Review cost-index increase",
        "attribution_anomaly": "Review attribution change",
    }
    return f"{finding['campaignName']}: {type_titles.get(finding['type'], 'Review verified performance signal')}"


def level_for(finding: dict) -> str:
    previous = finding["raw"].get("previousClicks") or 0
    if finding["raw"]["clicks"] >= 500 and previous >= 500 and finding["severity"] == "high":
        return "sufficient"
    if finding["raw"]["clicks"] >= 80 and previous >= 80:
        return "limited"
    return "insufficient"


def risk_for(action: str) -> str:
    if action in ("pause_candidate", "decrease_priority"):
        return "high"
    if action == "increase_priority":
        return "medium"
    return "low"


def risk_note(action: str, finding: dict) -> str:
    if action == "pause_candidate":
        return f"{finding['campaignName']} will be marked for review before pausing. This is not an executed pause, and no platform pause integration is available."
    if action == "decrease_priority":
        return "Lower priority may reduce future delivery. The available data cannot estimate the amount."
    if action == "increase_priority":
        return "Higher priority may direct more traffic to this campaign. The available data cannot estimate the increment."
    return "Manual review does not change campaign delivery."


def guard(finding: dict, action: str, reason: str, evidence_level: str) -> dict:
    import re

    errors = []
    confidence = 0.8 if evidence_level == "sufficient" else 0.66 if evidence_level == "limited" else 0.5
    if re.search(r"预算|出价|ROAS|CPA|素材疲劳|节省", reason) and not re.search(r"没有|不能|不可|未提供|不是", reason):
        errors.append("The rationale cannot present unavailable fields as verified causes or outcomes.")
    strategy = {
        "id": None,
        "title": f"{finding['campaignName']} {ACTION_LABEL[action]}",
        "summary": reason,
        "targetCampaigns": [finding["campaignId"]],
        "evidence": [
            {
                "campaignId": finding["campaignId"],
                "facts": [finding["fact"], finding["interpretation"], finding["hypothesis"]],
                "metrics": {},
            }
        ],
        "actions": [{"campaignId": finding["campaignId"], "actionType": action, "reason": reason, "percentage": None}],
        "risks": [risk_note(action, finding), f"{EVIDENCE_LABEL[evidence_level]}."],
        "confidence": confidence,
    }
    result = validate_strategy(strategy)
    return {"passed": result["passed"] and not errors, "errors": [*errors, *result["errors"]], "warnings": result["warnings"]}


def comparison(campaign_id: str, action: str):
    if action in ("review", "hold"):
        return None
    simulation = simulate_strategy([{"campaignId": campaign_id, "actionType": action, "reason": ACTION_LABEL[action], "percentage": None}])
    effect = next((e for e in simulation["actionEffects"] if e["campaignId"] == campaign_id), None)
    if not effect or effect["weight"] == 1:
        return None
    return {
        "weight": effect["weight"],
        "baselineScore": effect["baseline"]["score"],
        "comparedScore": effect["strategy"]["score"],
        "disclaimer": "This offline weighting uses historical logs for directional comparison only; it is not a forecast of platform results.",
    }

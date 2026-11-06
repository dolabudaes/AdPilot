from __future__ import annotations

from app.services.analytics import get_campaign_by_id, get_campaign_facts, get_campaign_trend

ALLOWED_ACTIONS = ["increase_priority", "decrease_priority", "hold", "review", "pause_candidate"]
ANON_FIELD_TERMS = ["年龄", "性别", "地区", "地域", "收入", "商品", "行业", "品牌", "素材", "人群画像"]


def collect_numbers(value, target=None):
    target = target if target is not None else []
    if isinstance(value, (int, float)) and value == value:
        target.append(float(value))
        return target
    if isinstance(value, list):
        for item in value:
            collect_numbers(item, target)
    elif isinstance(value, dict):
        for item in value.values():
            collect_numbers(item, target)
    return target


def close_enough(a: float, b: float) -> bool:
    return abs(a - b) <= max(1e-9, abs(b) * 1e-9)


def text_implies_anonymous_inference(text: str) -> bool:
    has_term = any(term in text for term in ANON_FIELD_TERMS)
    if not has_term:
        return False
    return not any(x in text for x in ("不能", "不可", "不解释", "匿名"))


def collect_text(value, target=None):
    target = target if target is not None else []
    if isinstance(value, str):
        target.append(value)
    elif isinstance(value, list):
        for item in value:
            collect_text(item, target)
    elif isinstance(value, dict):
        for item in value.values():
            collect_text(item, target)
    return target


def validate_strategy(strategy: dict, _goal=None) -> dict:
    errors = []
    warnings = []
    if not strategy.get("targetCampaigns"):
        errors.append("Strategy does not reference any campaign.")
    action_campaigns = {a["campaignId"] for a in strategy.get("actions", [])}
    for campaign_id in strategy.get("targetCampaigns", []):
        campaign = get_campaign_by_id(campaign_id)
        if not campaign:
            errors.append(f"Strategy references a campaign that does not exist: {campaign_id}")
        elif campaign_id not in action_campaigns:
            warnings.append(f"{campaign_id} is in targetCampaigns but has no matching action.")
    for action in strategy.get("actions", []):
        if action.get("actionType") not in ALLOWED_ACTIONS:
            errors.append(f"{action.get('campaignId')} uses a disallowed actionType: {action.get('actionType')}")
        if not get_campaign_by_id(action.get("campaignId")):
            errors.append(f"Action references a campaign that does not exist: {action.get('campaignId')}")
        if action.get("percentage") is not None:
            warnings.append(f"{action.get('campaignId')} includes an adjustment percentage—show only when explainable.")
    for evidence in strategy.get("evidence", []):
        campaign = get_campaign_by_id(evidence.get("campaignId"))
        if not campaign:
            errors.append(f"Evidence references a campaign that does not exist: {evidence.get('campaignId')}")
            continue
        facts = get_campaign_facts(evidence.get("campaignId"))
        trend = get_campaign_trend(evidence.get("campaignId"))
        allowed = collect_numbers(campaign) + collect_numbers(facts) + collect_numbers(trend) + [len(trend)]
        for value in collect_numbers(evidence.get("metrics")):
            if not any(close_enough(value, a) for a in allowed):
                errors.append(
                    f"{evidence.get('campaignId')} evidence metrics include a number analytics cannot verify: {value}"
                )
    text = "\n".join(collect_text(strategy))
    if text_implies_anonymous_inference(text):
        errors.append("Recommendation copy must not interpret campaign labels as brand, audience, or region.")
    evidence_count = sum(len(e.get("facts", [])) + len(e.get("metrics", {})) for e in strategy.get("evidence", []))
    confidence = strategy.get("confidence", 0)
    if confidence > 0.9 and evidence_count < 6:
        errors.append("Insufficient evidence for a high-confidence strong conclusion.")
    elif confidence > 0.85:
        warnings.append("Strategy confidence is high—confirm evidence is sufficient.")
    return {"passed": len(errors) == 0, "errors": errors, "warnings": warnings}

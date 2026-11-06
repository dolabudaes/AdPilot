from app.services.analytics import get_campaigns


SIMULATION_RULES = [
    "Baseline uses historical aggregated totals for the selected campaigns.",
    "increase_priority uses a 1.10 weight in offline comparison.",
    "decrease_priority uses a 0.90 weight in offline comparison.",
    "pause_candidate uses a 0.65 weight for pause-candidate review—not a real pause.",
    "hold and review use a 1.00 weight.",
    "score = attributedConversions - cost * 0.001, for historical strategy direction comparison only.",
]


def action_weight(action_type: str) -> float:
    return {"increase_priority": 1.1, "decrease_priority": 0.9, "pause_candidate": 0.65}.get(action_type, 1.0)


def summarize(campaigns_weighted: list[tuple[dict, float]]) -> dict:
    totals = {"impressions": 0, "clicks": 0, "conversions": 0, "attributedConversions": 0, "cost": 0.0, "score": 0}
    for campaign, weight in campaigns_weighted:
        totals["impressions"] += round(campaign["impressions"] * weight)
        totals["clicks"] += round(campaign["clicks"] * weight)
        totals["conversions"] += round(campaign["conversions"] * weight)
        totals["attributedConversions"] += round(campaign["attributed_conversions"] * weight)
        totals["cost"] += campaign["total_cost"] * weight
    totals["cost"] = round(totals["cost"], 6)
    totals["score"] = round(totals["attributedConversions"] - totals["cost"] * 0.001, 6)
    return totals


def simulate_strategy(actions: list[dict]) -> dict:
    campaigns = get_campaigns()
    by_id = {c["campaign_id"]: c for c in campaigns}
    action_by_campaign = {a["campaignId"]: a for a in actions}
    baseline = summarize([(c, 1.0) for c in campaigns])
    weighted = [(c, action_weight(action_by_campaign[c["campaign_id"]]["actionType"]) if c["campaign_id"] in action_by_campaign else 1.0) for c in campaigns]
    strategy = summarize(weighted)
    action_effects = []
    for action in actions:
        campaign = by_id.get(action["campaignId"])
        if not campaign:
            continue
        weight = action_weight(action["actionType"])
        action_effects.append(
            {
                "campaignId": action["campaignId"],
                "actionType": action["actionType"],
                "weight": weight,
                "baseline": summarize([(campaign, 1.0)]),
                "strategy": summarize([(campaign, weight)]),
                "note": f"{action['actionType']} uses offline weight {weight:.2f}.",
            }
        )
    return {
        "baseline": baseline,
        "strategy": strategy,
        "changedCampaigns": [e["campaignId"] for e in action_effects if e["weight"] != 1],
        "actionEffects": action_effects,
        "rules": SIMULATION_RULES,
        "note": "Strategy comparison for the current historical window.",
    }

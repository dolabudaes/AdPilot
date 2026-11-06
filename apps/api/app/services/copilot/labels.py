ACTION_LABEL = {
    "increase_priority": "Increase priority",
    "decrease_priority": "Decrease priority",
    "hold": "Continue monitoring",
    "review": "Manual review",
    "pause_candidate": "Review before pausing",
}

FINDING_LABEL = {
    "cvr_anomaly": "Conversion-link rate decline",
    "weak_click_efficiency": "Weak click conversion-link",
    "cost_rise": "Cost index increase",
    "scale_opportunity": "Conversion-link rate improvement",
    "attribution_anomaly": "Attribution anomaly",
    "data_gap": "Insufficient data",
}

METRIC_HINT = {
    "clicks": "Clicks in the selected analysis window.",
    "conversions": "Clicks that received a future 30-day conversion label in this log snapshot. Not confirmed purchases or revenue.",
    "cvr": "Share of clicks with a future 30-day conversion label in this window. Not live platform CVR, attributed ROI, or full-account conversion rate.",
    "attributed": "Log-attributed conversion links in this snapshot, not a commercial attribution report.",
    "cost": "Log cost index, not verified spend or budget.",
    "ctr": "Clicks / impressions in this log sample.",
    "impressions": "Impressions in this log sample, not a complete commercial delivery report.",
}

SEVERITY_LABEL = {"high": "High", "medium": "Medium", "low": "Low", "info": "Info"}

STATUS_LABEL = {
    "draft": "Draft",
    "confirmed": "Confirmed",
    "dismissed": "Dismissed",
}

EVIDENCE_LABEL = {
    "sufficient": "Sufficient evidence",
    "limited": "Limited evidence",
    "insufficient": "Insufficient evidence",
}


def format_count(value):
    if value is None or not isinstance(value, (int, float)):
        return "—"
    return f"{int(value):,}"


def format_rate(value):
    from app.services.workbench.format import pct

    return pct(value, 2)


def format_change(value):
    from app.services.workbench.format import signed_pct

    if value is None or not isinstance(value, (int, float)):
        return "No comparison"
    return signed_pct(value, 1)


def format_cost(value):
    if value is None or not isinstance(value, (int, float)):
        return "—"
    n = float(value)
    if n != 0 and abs(n) < 1:
        return f"{n:.4g}"
    if abs(n) < 10_000:
        return f"{n:.3f}"
    from app.services.workbench.format import compact

    return compact(n, 2)


def delta_tone(metric: str, value):
    if value is None or value == 0:
        return "neutral"
    if metric == "cost":
        return "neutral"
    return "positive" if value > 0 else "negative"

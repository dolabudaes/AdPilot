ISSUE_TITLE = {
    "cvr_anomaly": "Conversion-link rate review",
    "weak_click_efficiency": "Click conversion-link review",
    "cost_rise": "Rising acquisition costs",
    "scale_opportunity": "Conversion-link rate improvement",
    "attribution_anomaly": "Attribution pattern review",
    "data_gap": "Insufficient sample review",
}


def issue_title_for_finding(finding: dict) -> str:
    return ISSUE_TITLE.get(finding.get("type"), "Investigation")


def investigation_conversation_title(finding: dict) -> str:
    return f"{finding['campaignName']} · {issue_title_for_finding(finding)}"


def summarize_conversation_title(question: str, campaign_name: str | None = None) -> str:
    q = " ".join(question.split()).strip()
    lower = q.lower()
    name = campaign_name if campaign_name and campaign_name != "Account" else ""
    if not q or __import__("re").match(r"^(hi|hello|hey|test)\b[.!?\s]*$", q, __import__("re").I):
        return "New conversation"

    def topic(phrase: str) -> str:
        if name and name.lower() in lower:
            return f"{name} {phrase[0].lower()}{phrase[1:]}"
        return phrase

    if "which campaigns" in lower or "need attention" in lower:
        return "Campaigns needing attention"
    if "cvr" in lower or "conversion" in lower:
        return topic("Conversion decline")
    core = q.rstrip("?")
    if len(core) > 52:
        core = core[:49].rstrip() + "…"
    return topic(core[0].upper() + core[1:] if core else "New conversation")

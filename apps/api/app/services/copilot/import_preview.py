def preview_import(headers: list[str]) -> dict:
    required = {"campaign_id", "impressions", "clicks", "conversions", "attributed_conversions", "total_cost"}
    normalized = {h.strip().lower().replace(" ", "_") for h in headers}
    missing = sorted(required - normalized)
    warnings = [
        "cat1–cat9 are anonymous features only when present—they are not interpreted as audience, region, or brand."
    ]
    if "timestamp" not in normalized and "day" not in normalized:
        warnings.append("Without timestamp, daily trends cannot be rebuilt.")
    if missing:
        warnings.append("Required fields are missing; this file cannot become analytics data.")
    return {"headers": list(headers), "missing": missing, "warnings": warnings}

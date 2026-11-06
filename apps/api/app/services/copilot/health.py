from app.services.analytics import get_campaigns, get_dataset_meta, get_daily_metrics
from app.services.data_store import get_settings, list_analysis_runs, list_data_sources
from app.services.copilot.store import count_pending_decisions


def age_days(value: str | None):
    if not value:
        return None
    from datetime import datetime, timezone

    try:
        time = datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
    return max(0, int((datetime.now(timezone.utc).timestamp() - time) // 86400))


def get_data_health() -> dict:
    settings = get_settings()
    sources = list_data_sources()
    source = next((s for s in sources if s["id"] == "criteo-demo"), sources[0] if sources else None)
    meta = get_dataset_meta()
    daily = get_daily_metrics() if meta.ready else []
    campaigns = get_campaigns() if meta.ready else []
    days = sorted({row["day"] for row in daily})
    age = age_days(meta.generatedAt)
    stale = age is not None and age > settings["stale_after_days"]
    min_clicks = settings.get("analysis_min_clicks") or 80
    recent = [
        c
        for c in campaigns
        if c.get("recent_7d", {}).get("clicks", 0) >= min_clicks
        and c.get("previous_7d", {}).get("clicks", 0) >= min_clicks
    ]
    metadata = (source or {}).get("metadata") or {}
    if isinstance(metadata, str):
        import json

        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            metadata = {}
    affected = [
        "Budget, bid, and ROAS recommendations are not generated because the source data lacks those fields.",
    ]
    if not meta.ready:
        affected.insert(0, "Campaign diagnostics are unavailable because processed data files are missing.")
    if stale:
        affected.insert(0, f"Diagnostics describe a historical snapshot from {age} days ago, not today's account.")
    if not any(row.get("total_cost", 0) > 0 for row in daily):
        affected.append("Cost-index diagnostics are unavailable.")

    return {
        "serviceOnline": True,
        "sourceConnected": (source or {}).get("status") == "connected",
        "filesReady": meta.ready and len(campaigns) > 0 and len(daily) > 0,
        "generatedAt": meta.generatedAt,
        "ageDays": age,
        "stale": stale,
        "staleAfterDays": settings["stale_after_days"],
        "campaignCount": len(campaigns),
        "dayCount": len(days),
        "dayMin": days[0] if days else None,
        "dayMax": days[-1] if days else None,
        "diagnosableShare": len(recent) / len(campaigns) if campaigns else None,
        "fieldMapping": [{"source": str(v), "target": k} for k, v in (meta.fieldMapping or {}).items()],
        "unavailable": [
            {"field": "Budget", "reason": "The log has no budget field."},
            {"field": "Bid", "reason": "The log has no bid field."},
            {"field": "ROAS / CPA", "reason": "No revenue or target cost is available to compute these."},
            {"field": "Ad spend", "reason": "total_cost is a cost index only, not spend amount."},
        ],
        "affected": affected,
        "runs": [
            {
                "id": run["id"],
                "type": run["runType"],
                "status": run["status"],
                "startedAt": run["startedAt"],
                "error": run.get("error"),
                "summary": str(
                    (run.get("output") or {}).get("kind")
                    or (run.get("output") or {}).get("campaignCount")
                    or (run.get("input") or {}).get("query")
                    or run["runType"]
                ),
            }
            for run in list_analysis_runs(12)
        ],
        "lastUploadAt": (source or {}).get("lastSyncedAt"),
        "lastUploadName": metadata.get("lastFileName"),
    }


def pending_review_count():
    try:
        return count_pending_decisions()
    except Exception:
        return 0

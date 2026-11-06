from __future__ import annotations

from app.services.analytics import get_campaigns, get_dataset_meta
from app.services.copilot.diagnostics import DEMO_ACCOUNT_ID, diagnose, load_analysis_inputs
from app.services.copilot.health import age_days
from app.services.copilot.recommend import propose
from app.errors import CopilotError
from app.services.copilot.store import (
    confirm_recommendation,
    dismiss_recommendation,
    ensure_draft_decision,
    export_decision,
    get_decision,
    list_decisions,
    list_stored_recommendations,
    overlay_recommendation,
    recommendation_id_for,
    save_recommendation_edit,
    snapshot_findings,
    get_stored_recommendation,
)
from app.services.copilot.windows import resolve_window, window_options
from app.services.data_store import create_analysis_run, complete_analysis_run, fail_analysis_run, get_settings, list_analysis_runs, list_data_sources, set_analysis_progress
from app.services.copilot.diagnostics import campaign_series
from app.services.copilot.proposal_consistency import proposal_consistency_issue

STEPS = [
    {"id": "read", "label": "Read account data", "state": "done"},
    {"id": "check", "label": "Checked metric changes", "state": "done"},
    {"id": "locate", "label": "Located campaigns above thresholds", "state": "done"},
    {"id": "advise", "label": "Prepared reviewable recommendations", "state": "done"},
]


def build_product_model(input_data: dict | None = None) -> dict:
    input_data = input_data or {}
    from datetime import datetime, timezone

    checked_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    account_id = input_data.get("accountId") or DEMO_ACCOUNT_ID
    sources = safe_sources()
    account = {
        "id": account_id,
        "name": "Criteo log snapshot" if account_id == DEMO_ACCOUNT_ID else next((s["name"] for s in sources if s["id"] == account_id), "Demo ad account"),
        "demo": account_id == DEMO_ACCOUNT_ID,
    }
    meta = safe_meta()
    settings = safe_settings()
    base = empty_model(account, checked_at, window_options(meta))

    if account_id != DEMO_ACCOUNT_ID:
        base.update(
            {
                "emptyReason": "unknown_account",
                "briefing": {
                    **base["briefing"],
                    "headline": "This account has no analyzable data yet",
                    "summary": "Only processed demo logs can generate diagnostics today. Unconnected platforms are not shown as connected.",
                },
            }
        )
        return base

    if not meta.ready:
        connected = any(s["status"] == "connected" for s in sources)
        return {
            **base,
            "emptyReason": "not_synced" if connected else "no_source",
            "briefing": {
                **base["briefing"],
                "headline": "Data source is registered but analytics files are missing"
                if connected
                else "No connected data source for analysis",
                "summary": "Confirm summary files under data/processed have been generated."
                if connected
                else "Connect a data source before diagnostics can run.",
            },
        }

    window = resolve_window(input_data.get("windowId"), meta)
    if not window:
        return {**base, "emptyReason": "incomplete"}

    inputs = load_analysis_inputs()
    if not inputs["campaigns"] or not inputs["daily"]:
        return {**base, "emptyReason": "incomplete", "window": public_window(window), "generatedAt": meta.generatedAt}

    diagnosis = diagnose(
        {
            "accountId": account_id,
            "window": window,
            "campaigns": inputs["campaigns"],
            "daily": inputs["daily"],
            "minClicks": settings["analysis_min_clicks"],
            "meta": meta,
        }
    )
    stored = list_stored_recommendations(account_id, window.id)
    stored_by_finding = {s["findingId"]: s for s in stored if s.get("datasetVersion") == meta.datasetVersion}
    findings = []
    for draft in diagnosis["findings"]:
        live = propose(draft)
        saved = stored_by_finding.get(draft["id"])
        recommendation = overlay_recommendation(draft, saved, live)
        findings.append({**draft, "recommendation": recommendation, "stale": False})

    for saved in stored:
        if any(f["id"] == saved["findingId"] for f in findings):
            continue
        if saved["status"] == "draft" and not saved.get("userEdited"):
            continue
        if not saved.get("findingSnapshot"):
            continue
        snap = saved["findingSnapshot"]
        findings.append(
            {
                **snap,
                "recommendation": saved,
                "stale": True,
                "summary": f"{snap.get('summary', '')} The latest check no longer matches this rule; the saved recommendation is kept.",
            }
        )

    rank = {"high": 0, "medium": 1, "low": 2, "info": 3}
    findings.sort(key=lambda a: rank[a["severity"]])
    by_campaign = {}
    for f in findings:
        cur = by_campaign.get(f["campaignId"])
        if not cur or rank[f["severity"]] < rank[cur["severity"]]:
            by_campaign[f["campaignId"]] = f

    open_rec = sum(1 for f in findings if f.get("recommendation") and f["recommendation"]["status"] == "draft")
    problems = [f for f in findings if f["severity"] in ("high", "medium")]
    age = age_days(meta.generatedAt)
    stale = age is not None and age > settings["stale_after_days"]
    cvr = next((k for k in diagnosis["kpis"] if k["id"] == "cvr"), None)
    conversions = next((k for k in diagnosis["kpis"] if k["id"] == "conversions"), None)
    names = [p["campaignName"] for p in problems[:3]]
    if not window.compareLabel:
        headline = "No comparison window in full range—change anomalies were skipped"
    elif problems:
        headline = f"{window.label}: {len(problems)} issue(s) above threshold"
    else:
        headline = "No issues above threshold in this window"
    no_comp = "No comparison"
    summary = (
        f"{', '.join(names)} merit priority review. Post-click conversion-link rate change "
        f"{cvr['delta'] if cvr else no_comp}; conversion-linked clicks change "
        f"{conversions['delta'] if conversions else no_comp}. "
        "Recommendations require human approval; approval does not write to an ad platform."
        if problems
        else f"Post-click conversion-link rate change {cvr['delta'] if cvr else no_comp}; "
        f"conversion-linked clicks change {conversions['delta'] if conversions else no_comp}. "
        "Sub-threshold moves stay on the watchlist and are not written as optimization actions."
    )
    if stale:
        summary = f"{summary} Data is a historical snapshot from {age} days ago."

    steps = STEPS if window.compareLabel else [{**s, "label": "Skipped change anomalies—no comparison window"} if s["id"] == "locate" else s for s in STEPS]

    return {
        "ready": True,
        "demo": True,
        "stale": stale,
        "ageDays": age,
        "emptyReason": None,
        "account": account,
        "window": public_window(window),
        "windowOptions": window_options(meta),
        "generatedAt": meta.generatedAt,
        "checkedAt": checked_at,
        "savedRunAt": latest_saved_run(),
        "sourceLabel": "campaign_daily.csv / campaign_summary.json",
        "missing": diagnosis["missing"],
        "briefing": {
            "headline": headline,
            "summary": summary,
            "problemNames": names,
            "findingCount": len(problems),
            "openRecommendationCount": open_rec,
        },
        "steps": steps,
        "kpis": diagnosis["kpis"],
        "trend": diagnosis["trend"],
        "anomalies": diagnosis["anomalies"],
        "watchlist": diagnosis["watchlist"],
        "findings": findings,
        "campaigns": [
            {
                **c,
                "findingId": (by_campaign.get(c["id"]) or {}).get("id"),
                "anomaly": by_campaign[c["id"]]["title"] if c["id"] in by_campaign and by_campaign[c["id"]]["severity"] != "info" else None,
                "findingType": by_campaign[c["id"]]["type"] if c["id"] in by_campaign and by_campaign[c["id"]]["severity"] != "info" else None,
                "severity": by_campaign[c["id"]]["severity"] if c["id"] in by_campaign else None,
                "recommendationStatus": (by_campaign[c["id"]].get("recommendation") or {}).get("status") if c["id"] in by_campaign else None,
                "recommendationCount": 1 if c["id"] in by_campaign and by_campaign[c["id"]].get("recommendation") else 0,
            }
            for c in diagnosis["campaigns"]
        ],
    }


def get_campaign_detail(campaign_id: str, window_id: str | None = None) -> dict | None:
    model = build_product_model({"windowId": window_id, "accountId": DEMO_ACCOUNT_ID})
    row = next((c for c in model["campaigns"] if c["id"] == campaign_id), None)
    meta = get_dataset_meta()
    window = resolve_window(window_id, meta)
    if not row or not window:
        return None
    return {
        "row": row,
        "series": campaign_series(campaign_id, window),
        "findings": [f for f in model["findings"] if f["campaignId"] == campaign_id],
        "unavailable": [
            {"field": "Budget", "reason": "The current data source has no budget field."},
            {"field": "Bid", "reason": "The current data source has no bid field."},
            {"field": "ROAS", "reason": "No revenue data is available to compute ROAS."},
            {"field": "Ad spend", "reason": "Cost index cannot be treated as spend amount."},
        ],
        "window": model["window"],
        "demo": model["demo"],
        "stale": model["stale"],
        "generatedAt": model["generatedAt"],
    }


def ensure_finding_draft(finding_id: str, actor_id: str, conversation_id: str | None = None) -> dict:
    finding = require_live_finding(finding_id)
    if not finding.get("recommendation"):
        raise CopilotError("This issue has no proposal to save.", 404)
    return ensure_draft_decision(
        {
            "finding": as_draft(finding),
            "original": finding["recommendation"]["original"],
            "proposal": finding["recommendation"]["proposal"],
            "actorId": actor_id,
            "conversationId": conversation_id,
            "userEdited": finding["recommendation"].get("userEdited"),
        }
    )


def confirm_finding(finding_id: str, actor_id: str) -> dict:
    finding = require_live_finding(finding_id)
    if not finding.get("recommendation"):
        raise CopilotError("No recommendation is ready to confirm.", 404)
    issue = proposal_consistency_issue(finding["recommendation"]["proposal"]["actionType"], finding["recommendation"]["proposal"]["reason"])
    if issue:
        raise CopilotError(issue)
    return confirm_recommendation(
        {
            "finding": as_draft(finding),
            "proposal": finding["recommendation"]["proposal"],
            "original": finding["recommendation"]["original"],
            "actorId": actor_id,
        }
    )


def dismiss_finding(finding_id: str, actor_id: str) -> dict:
    finding = require_live_finding(finding_id)
    if not finding.get("recommendation"):
        raise CopilotError("No recommendation is available to dismiss.", 404)
    rec_id = recommendation_id_for(finding_id)
    if not get_stored_recommendation(rec_id):
        save_recommendation_edit(
            {
                "finding": as_draft(finding),
                "original": finding["recommendation"]["original"],
                "proposal": finding["recommendation"]["proposal"],
                "actorId": actor_id,
                "userEdited": finding["recommendation"].get("userEdited"),
            }
        )
    return dismiss_recommendation(rec_id, actor_id)


def edit_finding(finding_id: str, actor_id: str, action_type: str, reason: str) -> dict:
    finding = require_live_finding(finding_id)
    draft = as_draft(finding)
    proposal = propose(draft, {"actionType": action_type, "reason": reason})
    if not proposal:
        raise CopilotError("This issue has no editable recommendation.")
    original = (finding.get("recommendation") or {}).get("original") or propose(draft) or proposal
    return save_recommendation_edit(
        {"finding": draft, "original": original, "proposal": proposal, "actorId": actor_id}
    )


def parse_finding_id(fid: str):
    parts = fid.split(":")
    if parts[0] != "finding" or len(parts) < 5:
        return None
    return {"accountId": parts[1], "windowId": parts[2], "campaignId": ":".join(parts[3:-1]), "type": parts[-1]}


def require_live_finding(finding_id: str) -> dict:
    parsed = parse_finding_id(finding_id)
    if not parsed:
        raise CopilotError("Recommendation id could not be parsed.")
    model = build_product_model({"accountId": parsed["accountId"], "windowId": parsed["windowId"]})
    finding = next((f for f in model["findings"] if f["id"] == finding_id), None)
    if not finding:
        raise CopilotError("Finding not found.", 404)
    return finding


def as_draft(finding: dict) -> dict:
    return {k: v for k, v in finding.items() if k not in ("recommendation", "stale")}


def public_window(window) -> dict:
    return {
        "id": window.id,
        "label": window.label,
        "compareLabel": window.compareLabel,
        "start": window.start,
        "end": window.end,
        "compareStart": window.compareStart,
        "compareEnd": window.compareEnd,
    }


def latest_saved_run():
    try:
        run = next((r for r in list_analysis_runs(30) if (r.get("output") or {}).get("kind") == "copilot_refresh" and r["status"] == "completed"), None)
        return run["completedAt"] if run else None
    except Exception:
        return None


def safe_meta():
    try:
        return get_dataset_meta()
    except Exception:
        from app.services.analytics import DatasetMeta

        return DatasetMeta()


def safe_sources():
    try:
        return list_data_sources()
    except Exception:
        return []


def safe_settings():
    try:
        return get_settings()
    except Exception:
        return {"analysis_min_clicks": 80, "stale_after_days": 14}


def empty_model(account, checked_at, options) -> dict:
    return {
        "ready": False,
        "demo": account["demo"],
        "stale": False,
        "ageDays": None,
        "emptyReason": "incomplete",
        "account": account,
        "window": None,
        "windowOptions": options,
        "generatedAt": None,
        "checkedAt": checked_at,
        "savedRunAt": None,
        "sourceLabel": "processed files",
        "missing": [],
        "briefing": {"headline": "Diagnostics unavailable", "summary": "Readable campaign data is required.", "problemNames": [], "findingCount": 0, "openRecommendationCount": 0},
        "steps": [],
        "kpis": [],
        "trend": [],
        "anomalies": [],
        "watchlist": [],
        "findings": [],
        "campaigns": [],
    }

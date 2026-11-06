from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from app.db import get_db, next_id
from app.services.json_util import parse_json

DataSourceStatus = Literal["connected", "pending", "error"]


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def overwrite_campaign_metrics(rows: list[Any]) -> None:
    db = get_db()
    db.execute("DELETE FROM campaign_metrics")
    insert = """INSERT INTO campaign_metrics (
      campaign_id, impressions, clicks, conversions, attributed_conversions, cost, ctr,
      conversion_rate, attributed_conversion_rate, cost_efficiency, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)"""
    now = _iso_now()
    for m in rows:
        db.execute(
            insert,
            (
                m.campaignId,
                m.impressions,
                m.clicks,
                m.conversions,
                m.attributedConversions,
                m.cost,
                m.ctr,
                m.conversionRate,
                m.attributedConversionRate,
                m.costEfficiency,
                now,
            ),
        )
    db.commit()


def import_dataset(rows: list[dict]) -> dict[str, Any]:
    from app.services.analytics import aggregate_campaigns

    metrics = aggregate_campaigns(rows, 50)
    overwrite_campaign_metrics(metrics)
    touch_data_source(
        "criteo-demo",
        {
            "status": "connected",
            "metadataPatch": {
                "importMode": "file_import",
                "lastImportedRows": len(rows),
                "campaignCount": len(metrics),
            },
        },
    )
    return {"campaignCount": len(metrics), "metrics": metrics}


def ensure_seed_data(sample_rows: list[dict]) -> None:
    row = get_db().execute("SELECT COUNT(*) AS c FROM campaign_metrics").fetchone()
    if row and row["c"] == 0:
        import_dataset(sample_rows)


def get_settings() -> dict[str, Any]:
    row = get_db().execute(
        """SELECT llm_provider, llm_model, llm_base_url, llm_api_key, max_single_adjustment,
           analysis_min_clicks, stale_after_days FROM settings WHERE id = 1"""
    ).fetchone()
    return {
        "llm_provider": row["llm_provider"],
        "llm_model": row["llm_model"],
        "llm_base_url": row["llm_base_url"],
        "llm_api_key": row["llm_api_key"],
        "max_single_adjustment": float(row["max_single_adjustment"] or 0.2),
        "analysis_min_clicks": int(row["analysis_min_clicks"] or 80),
        "stale_after_days": int(row["stale_after_days"] or 14),
    }


def save_settings(settings: dict[str, Any]) -> None:
    get_db().execute(
        """UPDATE settings SET llm_provider=?, llm_model=?, llm_base_url=?, llm_api_key=?,
           max_single_adjustment=?, analysis_min_clicks=?, stale_after_days=?, updated_at=? WHERE id=1""",
        (
            settings["llm_provider"],
            settings["llm_model"],
            settings["llm_base_url"],
            settings["llm_api_key"],
            settings["max_single_adjustment"],
            max(20, round(settings.get("analysis_min_clicks") or 80)),
            max(1, round(settings.get("stale_after_days") or 14)),
            _iso_now(),
        ),
    )
    get_db().commit()


def set_analysis_progress(run_id: str, progress: Any) -> None:
    get_db().execute("UPDATE analysis_runs SET progress = ? WHERE id = ?", (json.dumps(progress), run_id))
    get_db().commit()


def create_analysis_run(
    run_type: str,
    input_payload: dict,
    goal_id: int | None = None,
    strategy_id: int | None = None,
) -> str:
    run_id = next_id()
    get_db().execute(
        """INSERT INTO analysis_runs (id, goal_id, strategy_id, status, run_type, input, output, error, started_at, completed_at)
           VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL, ?, NULL)""",
        (run_id, goal_id, strategy_id, run_type, json.dumps(input_payload), _iso_now()),
    )
    get_db().commit()
    return run_id


def complete_analysis_run(run_id: str, update: dict) -> None:
    get_db().execute(
        """UPDATE analysis_runs SET status='completed', goal_id=COALESCE(?, goal_id), strategy_id=COALESCE(?, strategy_id),
           output=?, completed_at=? WHERE id=?""",
        (
            update.get("goalId"),
            update.get("strategyId"),
            json.dumps(update.get("output") or {}),
            _iso_now(),
            run_id,
        ),
    )
    get_db().commit()


def fail_analysis_run(run_id: str, error: str) -> None:
    get_db().execute(
        "UPDATE analysis_runs SET status='failed', error=?, completed_at=? WHERE id=?",
        (error, _iso_now(), run_id),
    )
    get_db().commit()


def list_analysis_runs(limit: int = 25) -> list[dict]:
    rows = get_db().execute(
        """SELECT id, goal_id, strategy_id, status, run_type, input, output, error, started_at, completed_at
           FROM analysis_runs ORDER BY started_at DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    out = []
    for row in rows:
        out.append(
            {
                "id": row["id"],
                "goalId": row["goal_id"],
                "strategyId": row["strategy_id"],
                "status": row["status"],
                "runType": row["run_type"],
                "input": parse_json(row["input"], {}),
                "output": parse_json(row["output"], None),
                "error": row["error"],
                "startedAt": row["started_at"],
                "completedAt": row["completed_at"],
            }
        )
    return out


def list_data_sources() -> list[dict]:
    rows = get_db().execute(
        """SELECT id, name, provider, status, source_type, metadata, last_synced_at, created_at, updated_at
           FROM data_sources ORDER BY created_at ASC"""
    ).fetchall()
    result = []
    for row in rows:
        result.append(
            {
                "id": row["id"],
                "name": row["name"],
                "provider": row["provider"],
                "status": row["status"],
                "sourceType": row["source_type"],
                "metadata": parse_json(row["metadata"], {}),
                "lastSyncedAt": row["last_synced_at"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
        )
    return result


def touch_data_source(source_id: str, update: dict | None = None) -> dict | None:
    update = update or {}
    db = get_db()
    row = db.execute("SELECT metadata FROM data_sources WHERE id = ?", (source_id,)).fetchone()
    if not row:
        return None
    now = _iso_now()
    metadata = {**parse_json(row["metadata"], {}), **(update.get("metadataPatch") or {})}
    status = update.get("status")
    db.execute(
        """UPDATE data_sources SET status=COALESCE(?, status), metadata=?, last_synced_at=?, updated_at=? WHERE id=?""",
        (status, json.dumps(metadata), now, now, source_id),
    )
    db.commit()
    return next((s for s in list_data_sources() if s["id"] == source_id), None)


def update_strategy_status(strategy_id: int, status: str, simulation_result: str | None = None) -> None:
    now = _iso_now()
    if simulation_result:
        get_db().execute(
            "UPDATE strategies SET status=?, simulation_result=?, updated_at=? WHERE id=?",
            (status, simulation_result, now, strategy_id),
        )
    else:
        get_db().execute("UPDATE strategies SET status=?, updated_at=? WHERE id=?", (status, now, strategy_id))
    get_db().commit()


def get_stored_strategy(strategy_id: int) -> dict | None:
    row = get_db().execute(
        """SELECT s.*, g.raw_user_input, g.parsed_goal FROM strategies s
           INNER JOIN goals g ON g.id = s.goal_id WHERE s.id = ?""",
        (strategy_id,),
    ).fetchone()
    if not row:
        return None
    strategy = {
        "id": row["id"],
        "title": row["title"] or "AdPilot strategy",
        "summary": row["summary"],
        "targetCampaigns": parse_json(row["target_campaigns"], []),
        "evidence": parse_json(row["evidence"], []),
        "actions": parse_json(row["actions"], []),
        "risks": parse_json(row["risks"], []),
        "confidence": float(row["confidence"] or 0.7),
    }
    return {
        "strategy": strategy,
        "goalId": row["goal_id"],
        "rawGoal": row["raw_user_input"],
        "parsedGoal": parse_json(row["parsed_goal"], None),
        "guardrailStatus": row["guardrail_status"],
        "simulationResult": parse_json(row["simulation_result"], None),
        "status": row["status"],
    }


def list_campaign_metrics():
    from app.services.analytics import load_dataset

    return load_dataset(50).metrics

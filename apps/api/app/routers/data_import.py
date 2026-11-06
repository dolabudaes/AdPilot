from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.auth import deny_response
from app.services.analytics import get_campaigns
from app.services.copilot.import_preview import preview_import
from app.services.data_store import complete_analysis_run, create_analysis_run, fail_analysis_run, import_dataset
from app.services.utils.criteo_generator import build_demo_rows

router = APIRouter(prefix="/api/data/import", tags=["data-import"])


class ImportBody(BaseModel):
    mode: str | None = "demo"
    rows: list[dict[str, Any]] | None = None
    preview: bool | None = None
    headers: list[str] | None = None
    fileName: str | None = None
    rowCount: int | None = None


@router.post("")
@router.post("/")
def post_import(body: ImportBody, request: Request):
    if body.preview:
        denied = deny_response(request, "analyze")
        if denied:
            return denied
        preview = preview_import(body.headers or [])
        camps = get_campaigns()
        return {
            "ok": True,
            "preview": preview,
            "fileName": body.fileName or "",
            "rowCount": body.rowCount or 0,
            "willReplaceAnalysis": len(camps) == 0,
            "note": (
                "Current analysis still reads the processed demo snapshot. Recording an upload does not replace it."
                if camps
                else "Import writes to SQLite and becomes the analysis source only when processed files are missing."
            ),
        }
    denied = deny_response(request, "manage_data")
    if denied:
        return denied
    mode = body.mode or "demo"
    rows = body.rows if body.rows else (build_demo_rows(2000) if mode == "demo" else [])
    if not rows:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=400, content={"ok": False, "message": "No import data provided"})
    run_id = create_analysis_run("data_import", {"mode": mode, "rowCount": len(rows)})
    try:
        imported = import_dataset(rows)
        stats = [
            {
                "campaignId": m.campaignId,
                "impressions": m.impressions,
                "clicks": m.clicks,
                "conversions": m.conversions,
                "attributedConversions": m.attributedConversions,
                "cost": m.cost,
            }
            for m in imported["metrics"]
        ]
        complete_analysis_run(run_id, {"output": {"mode": mode, "campaignCount": imported["campaignCount"], "rowCount": len(rows)}})
        return {"ok": True, "runId": run_id, "mode": mode, "totalCampaigns": imported["campaignCount"], "metrics": stats}
    except Exception as e:
        fail_analysis_run(run_id, str(e))
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=500, content={"ok": False, "runId": run_id, "message": str(e)})

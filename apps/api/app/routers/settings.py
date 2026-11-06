from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.auth import deny_response, get_current_actor
from app.services.data_store import get_settings, save_settings

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
@router.get("/")
def get_settings_route(request: Request):
    try:
        settings = get_settings()
        actor = get_current_actor(request)
        return {"settings": dict(settings), "actor": actor}
    except Exception:
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=500,
            content={"message": "Settings could not be loaded. Check the local service."},
        )


class SettingsBody(BaseModel):
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    max_single_adjustment: float | None = None
    analysis_min_clicks: int | None = None
    stale_after_days: int | None = None


@router.post("")
@router.post("/")
def post_settings(body: SettingsBody, request: Request):
    denied = deny_response(request, "manage_settings")
    if denied:
        return denied
    if not body.llm_provider:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=400, content={"ok": False, "message": "Required configuration is missing."})
    current = get_settings()
    incoming_key = body.llm_api_key or ""
    save_settings(
        {
            **current,
            "llm_provider": body.llm_provider,
            "llm_model": body.llm_model or current["llm_model"],
            "llm_base_url": body.llm_base_url or current["llm_base_url"],
            "llm_api_key": incoming_key if incoming_key and "•" not in incoming_key else current["llm_api_key"],
            "max_single_adjustment": float(body.max_single_adjustment if body.max_single_adjustment is not None else current["max_single_adjustment"]),
            "analysis_min_clicks": int(body.analysis_min_clicks if body.analysis_min_clicks is not None else current["analysis_min_clicks"]),
            "stale_after_days": int(body.stale_after_days if body.stale_after_days is not None else current["stale_after_days"]),
        }
    )
    return {"ok": True}

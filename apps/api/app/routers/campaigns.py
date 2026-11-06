from urllib.parse import unquote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.services.copilot.service import get_campaign_detail

router = APIRouter(prefix="/api/campaigns", tags=["campaigns"])


@router.get("/{campaign_id}")
def get_campaign(campaign_id: str, request: Request, window: str | None = None):
    detail = get_campaign_detail(unquote(campaign_id), window)
    if not detail:
        return JSONResponse(status_code=404, content={"ok": False, "message": "Campaign not found"})
    return {"ok": True, "detail": detail}

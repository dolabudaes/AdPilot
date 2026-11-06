from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.auth import deny_response, get_current_actor
from app.errors import CopilotError
from app.services.copilot.store import action_allowed
from app.services.copilot.strategy_versions import list_strategy_versions, save_strategy_version

router = APIRouter(prefix="/api/strategy-versions", tags=["strategy-versions"])


@router.get("")
@router.get("/")
def get_versions(request: Request, finding: str | None = None):
    denied = deny_response(request, "read")
    if denied:
        return denied
    if not finding:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=400, content={"ok": False, "message": "Missing finding."})
    return {"ok": True, "versions": list_strategy_versions(finding)}


class SaveVersionBody(BaseModel):
    findingId: str | None = None
    actionType: str | None = None
    reason: str | None = None
    source: str | None = None
    conversationId: str | None = None
    messageId: str | None = None


@router.post("")
@router.post("/")
def post_version(body: SaveVersionBody, request: Request):
    denied = deny_response(request, "edit_recommendation")
    if denied:
        return denied
    if not body.findingId or not body.actionType or not action_allowed(body.actionType):
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=400, content={"ok": False, "message": "The strategy context is incomplete."})
    try:
        version = save_strategy_version(
            {
                "findingId": body.findingId,
                "actionType": body.actionType,
                "reason": body.reason or "",
                "source": body.source,
                "conversationId": body.conversationId,
                "messageId": body.messageId,
                "actorId": get_current_actor(request)["id"],
            }
        )
        return {"ok": True, "version": version}
    except CopilotError as e:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=e.status, content={"ok": False, "message": e.message})

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from urllib.parse import unquote

from app.auth import deny_response, get_current_actor
from app.errors import CopilotError
from app.services.copilot.service import confirm_finding, dismiss_finding, ensure_finding_draft
from app.services.copilot.store import (
    confirm_decision,
    create_revision_decision,
    dismiss_decision,
    export_decision,
    get_decision,
    list_decisions,
    update_draft_decision,
)

router = APIRouter(prefix="/api/decisions", tags=["decisions"])

STATUSES = {"draft", "confirmed", "dismissed", "all"}


def _error(exc: CopilotError):
    return JSONResponse(status_code=exc.status, content={"ok": False, "message": exc.message})


@router.get("")
@router.get("/")
def get_decisions(status: str | None = None):
    filt = status if status in STATUSES else "all"
    return {"ok": True, "decisions": list_decisions(None if filt == "all" else filt)}


class DecisionCreate(BaseModel):
    recommendationId: str | None = None
    findingId: str | None = None
    conversationId: str | None = None


class DecisionPatch(BaseModel):
    title: str | None = None
    reason: str | None = None
    verificationSteps: str | None = None
    userNotes: str | None = None


@router.post("")
@router.post("/")
def post_decisions(body: DecisionCreate, request: Request):
    denied = deny_response(request, "confirm_decision")
    if denied:
        return denied
    finding_id = body.findingId
    if not finding_id and body.recommendationId:
        from app.services.copilot.store import get_stored_recommendation
        stored = get_stored_recommendation(body.recommendationId)
        finding_id = stored["findingId"] if stored else None
    if not finding_id:
        return JSONResponse(status_code=400, content={"ok": False, "message": "Recommendation is required"})
    try:
        decision = ensure_finding_draft(finding_id, get_current_actor(request)["id"], body.conversationId)
        return {"ok": True, "decision": decision}
    except CopilotError as e:
        return _error(e)
    except Exception as e:
        return JSONResponse(status_code=500, content={"ok": False, "message": str(e)})


class FindingBody(BaseModel):
    findingId: str


@router.post("/dismiss-finding")
def dismiss_finding_route(body: FindingBody, request: Request):
    denied = deny_response(request, "dismiss_decision")
    if denied:
        return denied
    try:
        decision = dismiss_finding(body.findingId, get_current_actor(request)["id"])
        return {"ok": True, "decision": decision}
    except CopilotError as e:
        return _error(e)


@router.patch("/{decision_id}")
def patch_decision(decision_id: str, body: DecisionPatch, request: Request):
    denied = deny_response(request, "edit_recommendation")
    if denied:
        return denied
    try:
        decision = update_draft_decision(
            {
                "id": unquote(decision_id),
                "actorId": get_current_actor(request)["id"],
                "title": body.title,
                "reason": body.reason,
                "verificationSteps": body.verificationSteps,
                "userNotes": body.userNotes,
            }
        )
        return {"ok": True, "decision": decision}
    except CopilotError as e:
        return _error(e)


@router.post("/{decision_id}/revise")
def revise(decision_id: str, request: Request):
    denied = deny_response(request, "confirm_decision")
    if denied:
        return denied
    try:
        decision = create_revision_decision(unquote(decision_id), get_current_actor(request)["id"])
        return {"ok": True, "decision": decision}
    except CopilotError as e:
        return _error(e)


@router.post("/{decision_id}/confirm")
def confirm(decision_id: str, request: Request):
    denied = deny_response(request, "confirm_decision")
    if denied:
        return denied
    try:
        decision = confirm_decision(unquote(decision_id), get_current_actor(request)["id"])
        return {"ok": True, "decision": decision}
    except CopilotError as e:
        return _error(e)


class DismissBody(BaseModel):
    reason: str | None = None


@router.post("/{decision_id}/dismiss")
def dismiss(decision_id: str, request: Request, body: DismissBody | None = None):
    denied = deny_response(request, "dismiss_decision")
    if denied:
        return denied
    try:
        decision = dismiss_decision(unquote(decision_id), get_current_actor(request)["id"], (body.reason if body else None))
        return {"ok": True, "decision": decision}
    except CopilotError as e:
        return _error(e)


@router.post("/{decision_id}/export")
def export(decision_id: str, request: Request):
    denied = deny_response(request, "export")
    if denied:
        return denied
    try:
        result = export_decision(unquote(decision_id), get_current_actor(request)["id"])
        return {"ok": True, **result}
    except CopilotError as e:
        return _error(e)

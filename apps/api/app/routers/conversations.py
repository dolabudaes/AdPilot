from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.auth import deny_response, get_current_actor
from app.errors import CopilotError
from app.services.copilot import conversations as conv

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


@router.get("")
@router.get("/")
def list_conversations_route(request: Request, account: str | None = "criteo-demo", q: str | None = ""):
    denied = deny_response(request, "read")
    if denied:
        return denied
    actor = get_current_actor(request)
    return {"ok": True, "conversations": conv.list_conversations(actor["id"], account or "criteo-demo", q or "")}


class OpenConversationBody(BaseModel):
    accountId: str | None = None
    windowId: str | None = None
    findingId: str | None = None
    campaignId: str | None = None
    contextType: str | None = None
    resume: bool | None = True
    forceNew: bool | None = False


@router.post("")
@router.post("/")
async def open_conversation_route(body: OpenConversationBody, request: Request):
    denied = deny_response(request, "converse")
    if denied:
        return denied
    try:
        conversation = conv.open_conversation(
            {
                "ownerId": get_current_actor(request)["id"],
                "accountId": body.accountId or "criteo-demo",
                "windowId": body.windowId or "recent_7d",
                "findingId": body.findingId,
                "campaignId": body.campaignId,
                "contextType": body.contextType,
                "resume": body.resume is not False,
                "forceNew": body.forceNew is True,
            }
        )
        return {"ok": True, "conversation": conversation}
    except CopilotError as e:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=e.status, content={"ok": False, "message": e.message})


@router.get("/{conversation_id}")
def get_conversation(conversation_id: str, request: Request, before: str | None = None):
    denied = deny_response(request, "read")
    if denied:
        return denied
    try:
        actor = get_current_actor(request)
        conversation = conv.get_conversation_for_actor(conversation_id, actor["id"])
        page = conv.list_messages(conversation_id, actor["id"], before)
        rerun = None if before else conv.rerun_availability(conversation_id, actor["id"])
        return {"ok": True, "conversation": conversation, **page, "rerun": rerun}
    except CopilotError as e:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=e.status, content={"ok": False, "message": e.message})


class PatchConversationBody(BaseModel):
    title: str | None = None
    status: str | None = None


@router.patch("/{conversation_id}")
def patch_conversation(conversation_id: str, body: PatchConversationBody, request: Request):
    denied = deny_response(request, "converse")
    if denied:
        return denied
    try:
        actor = get_current_actor(request)
        if body.status == "archived":
            return {"ok": True, "conversation": conv.archive_conversation(conversation_id, actor["id"])}
        if not body.title:
            from fastapi.responses import JSONResponse

            return JSONResponse(status_code=400, content={"ok": False, "message": "Title is required"})
        return {"ok": True, "conversation": conv.rename_conversation(conversation_id, actor["id"], body.title)}
    except CopilotError as e:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=e.status, content={"ok": False, "message": e.message})


class MessageBody(BaseModel):
    content: str | None = ""
    clientKey: str | None = None
    retry: bool | None = False


@router.post("/{conversation_id}/messages")
async def post_message(conversation_id: str, body: MessageBody, request: Request):
    denied = deny_response(request, "converse")
    if denied:
        return denied
    client_key = (body.clientKey or "").strip()
    if not client_key:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=400, content={"ok": False, "message": "Message id is required"})
    try:
        actor = get_current_actor(request)
        result = (
            await conv.retry_message(conversation_id, actor["id"], client_key)
            if body.retry
            else await conv.send_message(conversation_id, actor["id"], body.content or "", client_key)
        )
        return {"ok": True, **result}
    except CopilotError as e:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=e.status, content={"ok": False, "message": e.message})


@router.get("/{conversation_id}/report")
def get_report(conversation_id: str, request: Request, reportId: str | None = None):
    from app.services.copilot.investigate import report as rep

    actor = get_current_actor(request)
    conv.get_conversation_for_actor(conversation_id, actor["id"])
    if reportId:
        report = rep.get_investigation_report(reportId)
        if not report or report["conversationId"] != conversation_id:
            from fastapi.responses import JSONResponse

            return JSONResponse(status_code=404, content={"ok": False, "message": "The report was not found."})
        return {"ok": True, "report": report}
    return {"ok": True, "reports": rep.list_reports_for_conversation(conversation_id)}


@router.post("/{conversation_id}/report")
def post_report(conversation_id: str, request: Request):
    from app.services.copilot.investigate import report as rep

    actor = get_current_actor(request)
    conversation = conv.get_conversation_for_actor(conversation_id, actor["id"])
    page = conv.list_messages(conversation_id, actor["id"], None, 80)
    completed = [m for m in page["messages"] if m["role"] == "assistant" and m["status"] == "completed"]
    if not completed:
        from fastapi.responses import JSONResponse

        return JSONResponse(
            status_code=400,
            content={"ok": False, "message": "This conversation does not contain a completed investigation result yet."},
        )
    saved = rep.save_investigation_report(conversation, page["messages"])
    return {"ok": True, "report": saved}

from __future__ import annotations

from fastapi import Request

from app.services.permissions import Permission, can

ACTOR_COOKIE = "adpilot_actor"

USER = {
    "id": "user",
    "name": "User",
    "role": "user",
    "title": "Reviews investigations and confirms or dismisses AI recommendations",
}


def list_actors() -> list[dict]:
    return [dict(USER)]


def get_current_actor(_request: Request | None = None) -> dict:
    return dict(USER)


def actor_can(_request: Request, permission: Permission) -> bool:
    return can("user", permission)


def deny_response(request: Request, permission: Permission):
    from fastapi.responses import JSONResponse

    actor = get_current_actor(request)
    if can(actor["role"], permission):
        return None
    return JSONResponse(
        status_code=403,
        content={"ok": False, "message": "This action is not available."},
    )

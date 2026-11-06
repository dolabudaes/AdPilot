from fastapi import APIRouter, Request

from app.auth import get_current_actor, list_actors

router = APIRouter(prefix="/api/session", tags=["session"])


@router.get("")
@router.get("/")
def get_session():
    return {"ok": True, "actor": get_current_actor(), "actors": list_actors()}


@router.post("")
@router.post("/")
def post_session():
    actor = get_current_actor()
    return {"ok": True, "actor": actor}

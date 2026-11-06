from fastapi import APIRouter

from app.services.copilot.health import get_data_health

router = APIRouter(tags=["health"])


@router.get("/health")
def health_root():
    return {"ok": True, "health": get_data_health()}


@router.get("/api/health")
def health_api():
    return {"ok": True, "health": get_data_health()}

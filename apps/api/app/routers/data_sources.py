from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.auth import deny_response
from app.services.copilot.health import get_data_health
from app.services.data_store import list_data_sources, touch_data_source

router = APIRouter(prefix="/api/data-sources", tags=["data-sources"])


@router.get("")
@router.get("/")
def get_data_sources():
    return {"ok": True, "dataSources": list_data_sources(), "health": get_data_health()}


class DataSourcePatch(BaseModel):
    id: str | None = None
    status: str | None = None
    metadata: dict | None = None


@router.post("")
@router.post("/")
def post_data_sources(body: DataSourcePatch, request: Request):
    denied = deny_response(request, "manage_data")
    if denied:
        return denied
    source_id = body.id or "criteo-demo"
    source = touch_data_source(source_id, {"status": body.status, "metadataPatch": body.metadata or {}})
    if not source:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=404, content={"ok": False, "message": "Data source not found"})
    return {"ok": True, "dataSource": source}

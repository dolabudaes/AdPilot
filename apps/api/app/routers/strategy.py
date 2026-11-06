from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.auth import deny_response
from app.services.data_store import complete_analysis_run, create_analysis_run, fail_analysis_run, get_stored_strategy, update_strategy_status
from app.services.simulation import simulate_strategy

router = APIRouter(prefix="/api/strategy/simulate", tags=["strategy"])


class SimulateBody(BaseModel):
    strategyId: int | None = None
    actions: list[dict[str, Any]] | None = None


@router.post("")
@router.post("/")
def simulate(body: SimulateBody, request: Request):
    denied = deny_response(request, "analyze")
    if denied:
        return denied
    if not body.strategyId:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=400, content={"ok": False, "message": "strategyId is required"})
    stored = get_stored_strategy(body.strategyId)
    if not stored:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=404, content={"ok": False, "message": "Strategy not found"})
    actions = body.actions if body.actions else stored["strategy"]["actions"]
    run_id = create_analysis_run(
        "simulation",
        {"actionCount": len(actions), "actions": actions},
        goal_id=stored["goalId"],
        strategy_id=body.strategyId,
    )
    try:
        import json

        result = simulate_strategy(actions)
        update_strategy_status(body.strategyId, "simulated", json.dumps(result))
        complete_analysis_run(
            run_id,
            {
                "goalId": stored["goalId"],
                "strategyId": body.strategyId,
                "output": {
                    "baselineScore": result["baseline"]["score"],
                    "strategyScore": result["strategy"]["score"],
                    "changedCampaigns": result["changedCampaigns"],
                },
            },
        )
        return {"ok": True, "runId": run_id, "strategyId": body.strategyId, "simulationResult": result}
    except Exception as e:
        fail_analysis_run(run_id, str(e))
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=500, content={"ok": False, "runId": run_id, "message": str(e)})

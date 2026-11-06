import app.env_load  # noqa: F401 — load repo-root .env.local before routers

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import (
    campaigns,
    conversations,
    data_import,
    data_sources,
    decisions,
    health,
    session,
    settings,
    strategy,
    strategy_versions,
)

app = FastAPI(title="AdPilot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3011", "http://127.0.0.1:3011"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(session.router)
app.include_router(settings.router)
app.include_router(data_sources.router)
app.include_router(data_import.router)
app.include_router(campaigns.router)
app.include_router(decisions.router)
app.include_router(conversations.router)
app.include_router(strategy_versions.router)
app.include_router(strategy.router)

from __future__ import annotations

import os
from pathlib import Path

from app import env_load  # noqa: F401 — ensure repo-root .env.local is loaded

# apps/api/app/paths.py -> repo root is parents[3]
_REPO_ROOT = Path(__file__).resolve().parents[3]
if os.environ.get("ADPILOT_REPO_ROOT"):
    _REPO_ROOT = Path(os.environ["ADPILOT_REPO_ROOT"]).resolve()


def repo_root() -> Path:
    return _REPO_ROOT


def _resolve_from_repo(value: str) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (repo_root() / path).resolve()


def data_dir() -> Path:
    raw = (os.environ.get("ADPILOT_DATA_DIR") or "").strip()
    if raw:
        return _resolve_from_repo(raw)
    return repo_root() / "data"


def sqlite_path() -> Path:
    raw = (os.environ.get("SQLITE_PATH") or "").strip()
    if raw:
        return _resolve_from_repo(raw)
    return data_dir() / "adpilot.db"


def processed_dir() -> Path:
    return data_dir() / "processed"

"""Load repo-root `.env.local` into process env (setdefault: real env wins)."""
from __future__ import annotations

import os
from pathlib import Path

_LOADED = False


def load_root_env() -> None:
    global _LOADED
    if _LOADED:
        return
    _LOADED = True

    # apps/api/app/env_load.py → repo root
    root = Path(__file__).resolve().parents[3]
    path = root / ".env.local"
    if not path.is_file():
        return

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[key] = value


load_root_env()

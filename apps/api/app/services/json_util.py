from __future__ import annotations

import json
from typing import Any, TypeVar

T = TypeVar("T")


def parse_json(value: Any, fallback: T) -> T:
    if not isinstance(value, str):
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback

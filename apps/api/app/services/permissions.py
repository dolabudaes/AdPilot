from __future__ import annotations

from typing import Literal

Role = Literal["user"]
Permission = Literal[
    "read",
    "analyze",
    "edit_recommendation",
    "confirm_decision",
    "dismiss_decision",
    "export",
    "manage_settings",
    "manage_data",
    "converse",
]


def can(_role: str, _permission: Permission) -> bool:
    return True


def is_role(value: str) -> bool:
    return value == "user"


def actor_role(_value: str | None = None) -> Role:
    return "user"

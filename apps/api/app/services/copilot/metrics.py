from __future__ import annotations

from app.services.workbench.format import finite, rate, wow


def conversion_link_rate(linked: float | None, clicks: float | None) -> float | None:
    return rate(linked, clicks)


def relative_change(current: float | None, previous: float | None) -> float | None:
    return wow(current, previous)


def percentage_point_change(current_rate: float | None, previous_rate: float | None) -> float | None:
    if current_rate is None or previous_rate is None:
        return None
    value = (current_rate - previous_rate) * 100
    return value if finite(value) is not None else None

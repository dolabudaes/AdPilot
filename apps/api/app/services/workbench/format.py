from __future__ import annotations


def finite(value) -> float | None:
    try:
        n = float(value) if not isinstance(value, (int, float)) else value
    except (TypeError, ValueError):
        return None
    return n if n == n and abs(n) != float("inf") else None


def rate(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator is None or denominator == 0:
        return None
    value = numerator / denominator
    return value if finite(value) is not None else None


def wow(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None or previous == 0:
        return None
    value = ((current - previous) / abs(previous)) * 100
    return value if finite(value) is not None else None


def compact(value: float | None, digits: int = 1) -> str:
    n = finite(value)
    if n is None:
        return "—"
    if abs(n) >= 1_000_000:
        return f"{n / 1_000_000:.{digits}f}M"
    if abs(n) >= 10_000:
        return f"{n / 1_000:.{digits}f}K"
    return f"{n:.{digits}f}"


def pct(value: float | None, digits: int = 2) -> str:
    n = finite(value)
    if n is None:
        return "—"
    return f"{n * 100:.{digits}f}%"


def signed_pct(value: float | None, digits: int = 1) -> str:
    n = finite(value)
    if n is None:
        return "—"
    sign = "+" if n > 0 else ""
    return f"{sign}{n:.{digits}f}%"

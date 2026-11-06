from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.services.analytics import DatasetMeta


@dataclass
class WindowSpec:
    id: str
    label: str
    compareLabel: str | None
    start: int
    end: int
    compareStart: int | None
    compareEnd: int | None


def window_options(meta: DatasetMeta) -> list[dict]:
    if not meta.ready:
        return []
    return [
        {"id": "recent_7d", "label": f"D{meta.recentStart}–D{meta.recentEnd}"},
        {"id": f"d{meta.previousStart}-d{meta.previousEnd}", "label": f"D{meta.previousStart}–D{meta.previousEnd}"},
        {"id": f"d1-d{meta.maxDay}", "label": f"D1–D{meta.maxDay}"},
    ]


def resolve_window(input_id: str | None, meta: DatasetMeta) -> WindowSpec | None:
    if not meta.ready or meta.maxDay < 1:
        return None
    start, end = meta.recentStart, meta.recentEnd
    if input_id and input_id != "recent_7d":
        import re

        match = re.match(r"^d(\d+)-d(\d+)$", input_id)
        if match:
            start, end = int(match.group(1)), int(match.group(2))
    if start < 1 or end > meta.maxDay or start > end:
        start, end = meta.recentStart, meta.recentEnd
    length = end - start + 1
    compare_end = start - 1
    compare_start = compare_end - length + 1
    has_compare = compare_start >= 1
    is_recent = start == meta.recentStart and end == meta.recentEnd
    return WindowSpec(
        id="recent_7d" if is_recent else f"d{start}-d{end}",
        label=f"D{start}–D{end}",
        compareLabel=f"D{compare_start}–D{compare_end}" if has_compare else None,
        start=start,
        end=end,
        compareStart=compare_start if has_compare else None,
        compareEnd=compare_end if has_compare else None,
    )

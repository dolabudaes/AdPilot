#!/usr/bin/env python3
"""Metric semantics for the Criteo attribution log.

The raw ``conversion`` and ``attribution`` flags label impression/click rows. A
single conversion_id can therefore occur on several rows. Row-label counts and
unique conversion-event counts are deliberately kept separate.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping


SECONDS_PER_DAY = 86_400


@dataclass
class AggregateState:
    impressions: int = 0
    clicks: int = 0
    conversion_linked_clicks: int = 0
    attributed_conversion_linked_clicks: int = 0
    total_cost_index: float = 0.0
    conversion_ids: set[str] = field(default_factory=set)
    attributed_conversion_ids: set[str] = field(default_factory=set)


def relative_day(timestamp: int | float, minimum_timestamp: int | float) -> int:
    return int((float(timestamp) - float(minimum_timestamp)) // SECONDS_PER_DAY) + 1


def add_row(state: AggregateState, row: Mapping[str, str]) -> None:
    click = int(float(row.get("click", "0") or 0))
    conversion = int(float(row.get("conversion", "0") or 0))
    attribution = int(float(row.get("attribution", "0") or 0))
    conversion_id = str(row.get("conversion_id", "-1"))

    state.impressions += 1
    state.clicks += click
    state.conversion_linked_clicks += conversion
    state.attributed_conversion_linked_clicks += attribution
    state.total_cost_index += float(row.get("cost", "0") or 0)
    if conversion and conversion_id != "-1":
        state.conversion_ids.add(conversion_id)
    if attribution and conversion_id != "-1":
        state.attributed_conversion_ids.add(conversion_id)


def ratio(numerator: int | float, denominator: int | float) -> float | None:
    return float(numerator) / float(denominator) if denominator else None


def finalize_totals(state: AggregateState) -> dict[str, int | float | None]:
    return {
        "impressions": state.impressions,
        "clicks": state.clicks,
        "conversion_linked_clicks": state.conversion_linked_clicks,
        "attributed_conversion_linked_clicks": state.attributed_conversion_linked_clicks,
        "unique_conversion_events": len(state.conversion_ids),
        "unique_attributed_conversion_events": len(state.attributed_conversion_ids),
        "total_cost_index": state.total_cost_index,
        "ctr": ratio(state.clicks, state.impressions),
        "post_click_conversion_link_rate": ratio(state.conversion_linked_clicks, state.clicks),
        "attribution_link_share": ratio(state.attributed_conversion_linked_clicks, state.conversion_linked_clicks),
    }

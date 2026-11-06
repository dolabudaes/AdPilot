#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import json
import re
import time
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from criteo_semantics import AggregateState, add_row, finalize_totals, ratio, relative_day

ROOT_DIR = Path(__file__).resolve().parents[1]
# Prefer data/ after monorepo cleanup; fall back to legacy root path.
_INPUT_CANDIDATES = [
    ROOT_DIR / "data" / "pcb_dataset_final.tsv",
    ROOT_DIR / "pcb_dataset_final.tsv",
]
INPUT_PATH = next((p for p in _INPUT_CANDIDATES if p.is_file()), _INPUT_CANDIDATES[0])
OUTPUT_DIR = ROOT_DIR / "data" / "processed"
DAILY_CSV_PATH = OUTPUT_DIR / "campaign_daily.csv"
SUMMARY_JSON_PATH = OUTPUT_DIR / "campaign_summary.json"
FACTS_JSON_PATH = OUTPUT_DIR / "campaign_facts.json"

TARGET_DEMO_CAMPAIGNS = 25
MIN_DEMO_CAMPAIGNS = 20
MAX_DEMO_CAMPAIGNS = 30

FIELD_ALIASES = {
    "timestamp": ["timestamp", "time", "ts", "event_timestamp", "event_time"],
    "uid": ["uid", "user_id", "userid", "user"],
    "campaign": ["campaign", "campaign_id", "campaignid", "campaignid_criteo"],
    "click": ["click", "clicked", "is_click"],
    "conversion": ["conversion", "converted", "is_conversion", "conv"],
    "conversion_timestamp": ["conversion_timestamp"],
    "conversion_id": ["conversion_id"],
    "attribution": ["attribution", "attributed", "is_attributed", "attributed_conversion"],
    "cost": ["cost", "price", "spend", "media_cost"],
    "cpo": ["cpo"],
}
REQUIRED_FIELDS = ["timestamp", "campaign", "click", "conversion", "conversion_timestamp", "conversion_id", "attribution", "cost", "cpo"]


@dataclass
class RowTotals:
    impressions: int = 0
    clicks: int = 0
    conversion_linked_clicks: int = 0
    attributed_conversion_linked_clicks: int = 0
    total_cost_index: float = 0.0


def normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def match_fields(columns: list[str]) -> dict[str, str | None]:
    lookup = {normalized(column): column for column in columns}
    return {name: next((lookup[normalized(alias)] for alias in aliases if normalized(alias) in lookup), None) for name, aliases in FIELD_ALIASES.items()}


def source_sha256() -> str:
    digest = hashlib.sha256()
    with INPUT_PATH.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def scan_source() -> tuple[list[str], dict[str, str | None], int, int, int, str]:
    if not INPUT_PATH.exists():
        raise FileNotFoundError(f"Input TSV not found: {INPUT_PATH}")
    with INPUT_PATH.open(newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        columns = list(reader.fieldnames or [])
        mapping = match_fields(columns)
        missing = [field for field in REQUIRED_FIELDS if not mapping.get(field)]
        if missing:
            raise ValueError(f"Required fields are missing: {', '.join(missing)}")
        minimum: int | None = None
        maximum: int | None = None
        rows = 0
        started = time.time()
        timestamp_col = mapping["timestamp"]
        assert timestamp_col
        for row in reader:
            timestamp = int(float(row[timestamp_col]))
            minimum = timestamp if minimum is None else min(minimum, timestamp)
            maximum = timestamp if maximum is None else max(maximum, timestamp)
            rows += 1
            if rows % 2_000_000 == 0:
                print(f"[scan] {rows:,} rows ({rows / max(time.time() - started, .001):,.0f} rows/s)")
    if minimum is None or maximum is None:
        raise ValueError("No rows found in source file")
    return columns, mapping, rows, minimum, maximum, source_sha256()


def add_daily(state: RowTotals, row: dict[str, str], mapping: dict[str, str | None]) -> None:
    click = int(float(row[mapping["click"]] or 0))
    conversion = int(float(row[mapping["conversion"]] or 0))
    attribution = int(float(row[mapping["attribution"]] or 0))
    state.impressions += 1
    state.clicks += click
    state.conversion_linked_clicks += conversion
    state.attributed_conversion_linked_clicks += attribution
    state.total_cost_index += float(row[mapping["cost"]] or 0)


def aggregate(mapping: dict[str, str | None], minimum_timestamp: int, expected_rows: int):
    campaign_states: dict[str, AggregateState] = defaultdict(AggregateState)
    daily_states: dict[tuple[str, int], RowTotals] = defaultdict(RowTotals)
    global_state = AggregateState()
    conversion_marker_rows = 0
    attribution_marker_rows = 0
    conversion_without_click_rows = 0
    min_conversion_timestamp: int | None = None
    max_conversion_timestamp: int | None = None
    min_cpo: float | None = None
    max_cpo: float | None = None
    started = time.time()
    with INPUT_PATH.open(newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        for index, raw in enumerate(reader, 1):
            row = {name: raw[column] for name, column in mapping.items() if column}
            campaign_id = row["campaign"]
            add_row(campaign_states[campaign_id], row)
            add_row(global_state, row)
            add_daily(daily_states[(campaign_id, relative_day(int(float(row["timestamp"])), minimum_timestamp))], raw, mapping)
            conversion = int(float(row["conversion"] or 0))
            attribution = int(float(row["attribution"] or 0))
            click = int(float(row["click"] or 0))
            conversion_marker_rows += conversion
            attribution_marker_rows += attribution
            if conversion and not click:
                conversion_without_click_rows += 1
            if conversion:
                conversion_timestamp = int(float(row["conversion_timestamp"]))
                min_conversion_timestamp = conversion_timestamp if min_conversion_timestamp is None else min(min_conversion_timestamp, conversion_timestamp)
                max_conversion_timestamp = conversion_timestamp if max_conversion_timestamp is None else max(max_conversion_timestamp, conversion_timestamp)
            cpo = float(row["cpo"] or 0)
            min_cpo = cpo if min_cpo is None else min(min_cpo, cpo)
            max_cpo = cpo if max_cpo is None else max(max_cpo, cpo)
            if index % 2_000_000 == 0:
                print(f"[aggregate] {index:,}/{expected_rows:,} rows ({index / max(time.time() - started, .001):,.0f} rows/s)")
    return campaign_states, daily_states, global_state, {
        "conversion_marker_rows": conversion_marker_rows,
        "attribution_marker_rows": attribution_marker_rows,
        "conversion_without_click_rows": conversion_without_click_rows,
        "minimum_conversion_timestamp": min_conversion_timestamp,
        "maximum_conversion_timestamp": max_conversion_timestamp,
        "minimum_cpo_index": min_cpo,
        "maximum_cpo_index": max_cpo,
    }


def metric_record(state: RowTotals | AggregateState) -> dict[str, Any]:
    if isinstance(state, AggregateState):
        base = finalize_totals(state)
        impressions, clicks = state.impressions, state.clicks
        conversions = state.conversion_linked_clicks
        attributed = state.attributed_conversion_linked_clicks
        cost = state.total_cost_index
        unique_conversion_events = int(base["unique_conversion_events"])
        unique_attributed_events = int(base["unique_attributed_conversion_events"])
    else:
        impressions, clicks = state.impressions, state.clicks
        conversions = state.conversion_linked_clicks
        attributed = state.attributed_conversion_linked_clicks
        cost = state.total_cost_index
        unique_conversion_events = None
        unique_attributed_events = None
    result = {
        "impressions": impressions,
        "clicks": clicks,
        "conversion_linked_clicks": conversions,
        "attributed_conversion_linked_clicks": attributed,
        "conversions": conversions,
        "attributed_conversions": attributed,
        "total_cost": round(cost, 12),
        "ctr": ratio(clicks, impressions),
        "conversion_rate": ratio(conversions, impressions),
        "attributed_conversion_rate": ratio(attributed, impressions),
        "click_to_conversion_rate": ratio(conversions, clicks),
        "post_click_conversion_link_rate": ratio(conversions, clicks),
        "attribution_share": ratio(attributed, conversions),
        "cost_efficiency": None,
    }
    if unique_conversion_events is not None:
        result["unique_conversion_events"] = unique_conversion_events
        result["unique_attributed_conversion_events"] = unique_attributed_events
    return result


def pct_change(current: float | int | None, previous: float | int | None) -> float | None:
    if current is None or previous in (None, 0):
        return 0.0 if current == 0 and previous == 0 else None
    return (float(current) - float(previous)) / float(previous) * 100


def changes_record(current: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    fields = ["impressions", "clicks", "conversions", "attributed_conversions", "ctr", "conversion_rate", "attributed_conversion_rate", "click_to_conversion_rate", "attribution_share"]
    changes: dict[str, Any] = {}
    for field in fields:
        left, right = current.get(field), previous.get(field)
        changes[f"{field}_delta"] = None if left is None or right is None else float(left) - float(right)
        changes[f"{field}_change_pct"] = pct_change(left, right)
    changes["total_cost_delta"] = None
    changes["total_cost_change_pct"] = None
    return changes


def select_demo_campaigns(campaign_states: dict[str, AggregateState]) -> list[str]:
    records = [(campaign_id, metric_record(state)) for campaign_id, state in campaign_states.items() if state.impressions > 0 and state.clicks > 0]
    impressions = sorted(int(metrics["impressions"]) for _, metrics in records)
    median = impressions[len(impressions) // 2] if impressions else 0
    q25 = impressions[len(impressions) // 4] if impressions else 0
    threshold = max(1_000, median)
    pool = [(campaign_id, metrics) for campaign_id, metrics in records if int(metrics["impressions"]) >= threshold]
    if len(pool) < MIN_DEMO_CAMPAIGNS:
        pool = [(campaign_id, metrics) for campaign_id, metrics in records if int(metrics["impressions"]) >= max(100, q25)]
    if len(pool) < MIN_DEMO_CAMPAIGNS:
        pool = records
    selected: OrderedDict[str, None] = OrderedDict()
    def add(field: str, reverse: bool, limit: int) -> None:
        for campaign_id, _ in sorted(pool, key=lambda item: float(item[1].get(field) or 0), reverse=reverse)[:limit]:
            selected.setdefault(campaign_id, None)
    add("impressions", True, 10)
    add("clicks", True, 8)
    add("conversion_linked_clicks", True, 8)
    add("conversion_rate", True, 6)
    add("click_to_conversion_rate", True, 6)
    add("ctr", True, 6)
    if len(selected) < TARGET_DEMO_CAMPAIGNS:
        add("impressions", True, TARGET_DEMO_CAMPAIGNS)
    chosen = list(selected)[:MAX_DEMO_CAMPAIGNS][:TARGET_DEMO_CAMPAIGNS]
    return sorted(chosen, key=lambda campaign_id: campaign_states[campaign_id].impressions, reverse=True)


def campaign_label(index: int) -> str:
    return f"Campaign {chr(ord('A') + index)}"


def window_record(daily: dict[tuple[str, int], RowTotals], raw_id: str, start: int, end: int) -> dict[str, Any]:
    total = RowTotals()
    for day in range(start, end + 1):
        value = daily.get((raw_id, day), RowTotals())
        total.impressions += value.impressions
        total.clicks += value.clicks
        total.conversion_linked_clicks += value.conversion_linked_clicks
        total.attributed_conversion_linked_clicks += value.attributed_conversion_linked_clicks
        total.total_cost_index += value.total_cost_index
    result = metric_record(total)
    result.update({"start_day": start, "end_day": end})
    return result


def fact_rows(campaign: dict[str, Any]) -> list[dict[str, Any]]:
    current, previous, changes = campaign["recent_7d"], campaign["previous_7d"], campaign["changes"]
    name = campaign["display_name"]
    output: list[dict[str, Any]] = []
    cvr_change = changes.get("click_to_conversion_rate_change_pct")
    if cvr_change is not None and abs(cvr_change) >= 5:
        direction = "increased" if cvr_change > 0 else "declined"
        output.append({"type": "conversion_link_rate_change", "text": f"{name}'s post-click conversion-link rate {direction} {abs(cvr_change):.1f}% versus the prior window.", "metrics": {"current": current["click_to_conversion_rate"], "previous": previous["click_to_conversion_rate"], "relative_change_pct": cvr_change}})
    click_change = changes.get("clicks_change_pct")
    if click_change is not None and abs(click_change) >= 5:
        direction = "increased" if click_change > 0 else "declined"
        output.append({"type": "click_change", "text": f"{name}'s clicks {direction} {abs(click_change):.1f}% versus the prior window.", "metrics": {"current": current["clicks"], "previous": previous["clicks"], "relative_change_pct": click_change}})
    attribution_change = changes.get("attribution_share_change_pct")
    if attribution_change is not None and abs(attribution_change) >= 5:
        direction = "increased" if attribution_change > 0 else "declined"
        output.append({"type": "attribution_link_share_change", "text": f"{name}'s attributed share of conversion-linked clicks {direction} {abs(attribution_change):.1f}%.", "metrics": {"current": current["attribution_share"], "previous": previous["attribution_share"], "relative_change_pct": attribution_change}})
    return output[:5] or [{"type": "stable_window", "text": f"{name} did not cross the configured click or conversion-link-rate thresholds.", "metrics": {}}]


def write_outputs(columns: list[str], mapping: dict[str, str | None], rows: int, minimum: int, maximum: int, source_hash: str, campaign_states, daily_states, global_state, audit) -> None:
    selected = select_demo_campaigns(campaign_states)
    display_lookup = {raw_id: campaign_label(index) for index, raw_id in enumerate(selected)}
    maximum_day = relative_day(maximum, minimum)
    current_start, current_end = max(1, maximum_day - 6), maximum_day
    previous_start, previous_end = max(1, current_start - 7), current_start - 1
    campaigns = []
    for raw_id in selected:
        totals = metric_record(campaign_states[raw_id])
        current = window_record(daily_states, raw_id, current_start, current_end)
        previous = window_record(daily_states, raw_id, previous_start, previous_end)
        campaigns.append({"campaign_id": display_lookup[raw_id], "display_name": display_lookup[raw_id], "raw_campaign_id": raw_id, **totals, "recent_7d": current, "previous_7d": previous, "changes": changes_record(current, previous)})
    generated_at = datetime.now(timezone.utc).isoformat()
    source_audit = finalize_totals(global_state)
    summary = {
        "schema_version": 2,
        "generated_at": generated_at,
        "source": {
            "dataset": "Criteo Attribution Modeling for Bidding Dataset",
            "release": "Diemert et al. 2017 public attribution dataset",
            "file_path": str(INPUT_PATH),
            "file_size_bytes": INPUT_PATH.stat().st_size,
            "sha256": source_hash,
            "row_count": rows,
            "field_names": columns,
            "field_mapping": mapping,
            "timestamp_min": minimum,
            "timestamp_max": maximum,
            "timestamp_day_rule": "D = floor((impression timestamp - minimum impression timestamp) / 86400) + 1",
            "date_assignment": "Daily metrics are assigned to the impression timestamp, not the conversion timestamp.",
            "campaign_selection": "25 deterministic demo campaigns selected from eligible campaigns using impression, click, conversion-link, CTR, and post-click conversion-link-rate ranks, then labeled A-Y by descending impressions.",
            "conversion_definition": "conversion is an impression/click-row label for a conversion within 30 days; it is not a unique conversion-event counter. conversion_id is deduplicated separately for audit totals.",
            "cost_definition": "cost is Criteo's transformed display-price index. The transform is undisclosed, so currency meaning and ratio-scale percentage improvement are unsupported.",
            "cpo_definition": "cpo is the dataset's transformed campaign cost-per-order feature. AdPilot records its observed range for audit only and does not aggregate or present it as currency, CPA, or an outcome metric.",
        },
        "audit": {**audit, **source_audit},
        "window": {"max_day": maximum_day, "recent_7d": {"start_day": current_start, "end_day": current_end}, "previous_7d": {"start_day": previous_start, "end_day": previous_end}},
        "campaigns": campaigns,
    }
    facts = {"schema_version": 2, "generated_at": generated_at, "source": {"summary_file": str(SUMMARY_JSON_PATH), "note": "Deterministic statements about impression-timestamp cohorts; no causal claims."}, "campaigns": [{"campaign_id": campaign["campaign_id"], "display_name": campaign["display_name"], "raw_campaign_id": campaign["raw_campaign_id"], "facts": fact_rows(campaign)} for campaign in campaigns]}
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    daily_columns = ["day", "campaign_id", "display_name", "raw_campaign_id", "impressions", "clicks", "conversion_linked_clicks", "attributed_conversion_linked_clicks", "conversions", "attributed_conversions", "total_cost", "ctr", "conversion_rate", "attributed_conversion_rate", "click_to_conversion_rate", "post_click_conversion_link_rate", "attribution_share", "cost_efficiency"]
    with DAILY_CSV_PATH.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=daily_columns)
        writer.writeheader()
        for (raw_id, day), state in sorted(daily_states.items(), key=lambda item: (item[0][1], display_lookup.get(item[0][0], ""))):
            if raw_id not in display_lookup:
                continue
            writer.writerow({"day": day, "campaign_id": display_lookup[raw_id], "display_name": display_lookup[raw_id], "raw_campaign_id": raw_id, **metric_record(state)})
    SUMMARY_JSON_PATH.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    FACTS_JSON_PATH.write_text(json.dumps(facts, indent=2, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    columns, mapping, rows, minimum, maximum, source_hash = scan_source()
    print(f"Source: {rows:,} rows, timestamps {minimum}..{maximum}, {len(columns)} fields")
    campaign_states, daily_states, global_state, audit = aggregate(mapping, minimum, rows)
    write_outputs(columns, mapping, rows, minimum, maximum, source_hash, campaign_states, daily_states, global_state, audit)
    print(f"Prepared {DAILY_CSV_PATH}, {SUMMARY_JSON_PATH}, and {FACTS_JSON_PATH}")


if __name__ == "__main__":
    main()

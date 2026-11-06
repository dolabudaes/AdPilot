from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from app.db import get_db
from app.paths import processed_dir

DEFAULT_MAX_CAMPAIGNS = 50


@dataclass
class CampaignMetric:
    campaignId: str
    impressions: int
    clicks: int
    conversions: int
    attributedConversions: int
    cost: float
    ctr: float
    conversionRate: float
    attributedConversionRate: float
    clickToConversionRate: float = 0.0
    costEfficiency: float = 0.0
    displayName: str | None = None
    rawCampaignId: str | None = None


@dataclass
class AnalyticsContext:
    metrics: list[CampaignMetric]
    total: dict[str, float | int]


@dataclass
class DatasetMeta:
    ready: bool = False
    schemaVersion: int | None = None
    generatedAt: str | None = None
    datasetVersion: str | None = None
    sourceSha256: str | None = None
    maxDay: int = 0
    recentStart: int = 0
    recentEnd: int = 0
    previousStart: int = 0
    previousEnd: int = 0
    sourceName: str | None = None
    rowCount: int | None = None
    conversionMarkerRows: int | None = None
    uniqueConversionEvents: int | None = None
    uniqueAttributedConversionEvents: int | None = None
    conversionWithoutClickRows: int | None = None
    fieldMapping: dict[str, str] = field(default_factory=dict)


EMPTY_META = DatasetMeta()


def _processed_paths() -> tuple[Path, Path, Path]:
    base = processed_dir()
    return base / "campaign_summary.json", base / "campaign_daily.csv", base / "campaign_facts.json"


def processed_ready() -> bool:
    s, d, f = _processed_paths()
    return s.is_file() and d.is_file() and f.is_file()


def as_number(value: Any, fallback: float = 0) -> float:
    try:
        parsed = float(value)
        return parsed if parsed == parsed else fallback
    except (TypeError, ValueError):
        return fallback


def read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as e:
        raise RuntimeError(f"Could not read processed data file {path}. Run npm run data:prepare first. Detail: {e}") from e


def parse_csv(file_path: Path) -> list[dict[str, str]]:
    text = file_path.read_text(encoding="utf-8").strip()
    if not text:
        return []
    lines = text.splitlines()
    header = lines[0].split(",")
    rows: list[dict[str, str]] = []
    for line in lines[1:]:
        values = line.split(",")
        rows.append({header[i]: values[i] if i < len(values) else "" for i in range(len(header))})
    return rows


def to_daily_metric(row: dict[str, str]) -> dict[str, Any]:
    return {
        "day": int(as_number(row.get("day"))),
        "campaign_id": row.get("campaign_id", ""),
        "display_name": row.get("display_name", ""),
        "raw_campaign_id": row.get("raw_campaign_id", ""),
        "impressions": int(as_number(row.get("impressions"))),
        "clicks": int(as_number(row.get("clicks"))),
        "conversions": int(as_number(row.get("conversions"))),
        "attributed_conversions": int(as_number(row.get("attributed_conversions"))),
        "total_cost": as_number(row.get("total_cost")),
        "ctr": as_number(row.get("ctr")),
        "conversion_rate": as_number(row.get("conversion_rate")),
        "attributed_conversion_rate": as_number(row.get("attributed_conversion_rate")),
        "click_to_conversion_rate": as_number(row.get("click_to_conversion_rate")),
        "attribution_share": as_number(row.get("attribution_share")),
        "cost_efficiency": as_number(row.get("cost_efficiency")),
    }


def get_campaigns() -> list[dict[str, Any]]:
    if not processed_ready():
        return []
    summary = read_json_file(_processed_paths()[0])
    campaigns = summary.get("campaigns") or []
    return sorted(campaigns, key=lambda c: c.get("impressions", 0), reverse=True)


def get_campaign_by_id(campaign_id: str) -> dict[str, Any] | None:
    cid = str(campaign_id)
    for campaign in get_campaigns():
        if campaign.get("campaign_id") == cid or campaign.get("raw_campaign_id") == cid:
            return campaign
    return None


def get_campaign_facts(campaign_id: str | None = None) -> list[dict[str, Any]]:
    if not processed_ready():
        return []
    facts = read_json_file(_processed_paths()[2]).get("campaigns") or []
    if not campaign_id:
        return facts
    return [f for f in facts if f.get("campaign_id") == campaign_id or f.get("raw_campaign_id") == campaign_id]


def get_campaign_trend(campaign_id: str) -> list[dict[str, Any]]:
    if not processed_ready():
        return []
    campaign = get_campaign_by_id(campaign_id)
    if not campaign:
        return []
    daily = [to_daily_metric(r) for r in parse_csv(_processed_paths()[1])]
    cid = campaign["campaign_id"]
    raw = campaign.get("raw_campaign_id")
    filtered = [r for r in daily if r["campaign_id"] == cid or r.get("raw_campaign_id") == raw]
    return sorted(filtered, key=lambda r: r["day"])


def compare_campaigns(metric: str = "attributed_conversion_rate", limit: int = 3) -> dict[str, Any]:
    campaigns = [c for c in get_campaigns() if as_number(c.get(metric)) == as_number(c.get(metric))]
    sorted_c = sorted(campaigns, key=lambda c: as_number(c.get(metric)), reverse=True)
    return {"top": sorted_c[:limit], "bottom": list(reversed(sorted_c[-limit:])), "metric": metric}


def get_top_conversion_campaigns(limit: int = 5) -> list[dict]:
    camps = [c for c in get_campaigns() if c.get("conversions", 0) > 0]
    camps.sort(key=lambda a: (a.get("conversion_rate", 0), a.get("conversions", 0)), reverse=True)
    return camps[:limit]


def get_low_efficiency_campaigns(limit: int = 5) -> list[dict]:
    camps = [c for c in get_campaigns() if c.get("clicks", 0) > 0]

    def penalty(c):
        return c.get("attributed_conversion_rate", 0) + c.get("click_to_conversion_rate", 0)

    camps.sort(key=lambda a: (penalty(a), a.get("clicks", 0)))
    return camps[:limit]


def get_recent_declining_campaigns(limit: int = 5) -> list[dict]:
    camps = []
    for c in get_campaigns():
        ch = c.get("changes") or {}
        if (ch.get("conversion_rate_change_pct") or 0) < 0 or (ch.get("attributed_conversion_rate_change_pct") or 0) < 0:
            camps.append(c)

    def decline(c):
        ch = c.get("changes") or {}
        return min(as_number(ch.get("conversion_rate_change_pct")), as_number(ch.get("attributed_conversion_rate_change_pct")))

    camps.sort(key=decline)
    return camps[:limit]


def summary_to_metric(campaign: dict) -> CampaignMetric:
    clicks = int(campaign.get("clicks") or 0)
    return CampaignMetric(
        campaignId=campaign["campaign_id"],
        displayName=campaign.get("display_name"),
        rawCampaignId=campaign.get("raw_campaign_id"),
        impressions=int(campaign.get("impressions") or 0),
        clicks=clicks,
        conversions=int(campaign.get("conversions") or 0),
        attributedConversions=int(campaign.get("attributed_conversions") or 0),
        cost=float(campaign.get("total_cost") or 0),
        ctr=float(campaign.get("ctr") or 0),
        conversionRate=float(campaign.get("conversion_rate") or 0),
        attributedConversionRate=float(campaign.get("attributed_conversion_rate") or 0),
        clickToConversionRate=float(campaign.get("click_to_conversion_rate") or (campaign.get("conversions", 0) / clicks if clicks else 0)),
        costEfficiency=float(campaign.get("cost_efficiency") or 0),
    )


def get_total_metrics(metrics: list[CampaignMetric]) -> dict[str, float | int]:
    acc = {"impressions": 0, "clicks": 0, "conversions": 0, "attributedConversions": 0, "cost": 0.0}
    for m in metrics:
        acc["impressions"] += m.impressions
        acc["clicks"] += m.clicks
        acc["conversions"] += m.conversions
        acc["attributedConversions"] += m.attributedConversions
        acc["cost"] += m.cost
    return acc


def load_dataset(limit_campaigns: int = DEFAULT_MAX_CAMPAIGNS) -> AnalyticsContext:
    processed = get_campaigns()
    if processed:
        metrics = [summary_to_metric(c) for c in processed[:limit_campaigns]]
        return AnalyticsContext(metrics=metrics, total=get_total_metrics(metrics))
    from app.services.seed import ensure_demo_if_empty

    ensure_demo_if_empty()
    rows = get_db().execute(
        """SELECT campaign_id, impressions, clicks, conversions, attributed_conversions, cost, ctr,
           conversion_rate, attributed_conversion_rate, cost_efficiency
           FROM campaign_metrics ORDER BY impressions DESC LIMIT ?""",
        (limit_campaigns,),
    ).fetchall()
    metrics = []
    for row in rows:
        clicks = row["clicks"]
        metrics.append(
            CampaignMetric(
                campaignId=row["campaign_id"],
                impressions=row["impressions"],
                clicks=clicks,
                conversions=row["conversions"],
                attributedConversions=row["attributed_conversions"],
                cost=row["cost"],
                ctr=row["ctr"],
                conversionRate=row["conversion_rate"],
                attributedConversionRate=row["attributed_conversion_rate"],
                clickToConversionRate=row["conversions"] / clicks if clicks else 0,
                costEfficiency=row["cost_efficiency"],
            )
        )
    return AnalyticsContext(metrics=metrics, total=get_total_metrics(metrics))


def get_campaign_performance(campaign_id: str) -> CampaignMetric | None:
    campaign = get_campaign_by_id(campaign_id)
    if campaign:
        return summary_to_metric(campaign)
    row = get_db().execute(
        """SELECT campaign_id, impressions, clicks, conversions, attributed_conversions, cost, ctr,
           conversion_rate, attributed_conversion_rate, cost_efficiency FROM campaign_metrics WHERE campaign_id = ?""",
        (campaign_id,),
    ).fetchone()
    if not row:
        return None
    clicks = row["clicks"]
    return CampaignMetric(
        campaignId=row["campaign_id"],
        impressions=row["impressions"],
        clicks=clicks,
        conversions=row["conversions"],
        attributedConversions=row["attributed_conversions"],
        cost=row["cost"],
        ctr=row["ctr"],
        conversionRate=row["conversion_rate"],
        attributedConversionRate=row["attributed_conversion_rate"],
        clickToConversionRate=row["conversions"] / clicks if clicks else 0,
        costEfficiency=row["cost_efficiency"],
    )


def aggregate_campaigns(rows: list[dict], limit_campaigns: int = DEFAULT_MAX_CAMPAIGNS) -> list[CampaignMetric]:
    state: dict[str, dict[str, float | int]] = {}
    for row in rows[:50000]:
        cid = row.get("campaign") or row.get("campaign_id")
        if not cid:
            continue
        if cid not in state:
            state[cid] = {"impressions": 0, "clicks": 0, "conversions": 0, "attributedConversions": 0, "cost": 0.0}
        s = state[cid]
        s["impressions"] = int(s["impressions"]) + 1
        s["clicks"] = int(s["clicks"]) + int(row.get("click") or 0)
        s["conversions"] = int(s["conversions"]) + int(row.get("conversion") or 0)
        s["attributedConversions"] = int(s["attributedConversions"]) + int(row.get("attribution") or 0)
        s["cost"] = float(s["cost"]) + float(row.get("cost") or 0)
    items = list(state.items())[:limit_campaigns]
    metrics = [calculate_metrics(cid, totals) for cid, totals in items]
    metrics.sort(key=lambda m: m.impressions, reverse=True)
    return metrics


def calculate_metrics(campaign_id: str, totals: dict) -> CampaignMetric:
    impressions = int(totals.get("impressions") or 0)
    clicks = int(totals.get("clicks") or 0)
    conversions = int(totals.get("conversions") or 0)
    attributed = int(totals.get("attributedConversions") or 0)
    cost = float(totals.get("cost") or 0)
    return CampaignMetric(
        campaignId=campaign_id,
        impressions=impressions,
        clicks=clicks,
        conversions=conversions,
        attributedConversions=attributed,
        cost=cost,
        ctr=clicks / impressions if impressions else 0,
        conversionRate=conversions / impressions if impressions else 0,
        attributedConversionRate=attributed / impressions if impressions else 0,
        clickToConversionRate=conversions / clicks if clicks else 0,
        costEfficiency=attributed / cost if cost else 0,
    )


def get_dataset_meta() -> DatasetMeta:
    if not processed_ready():
        return DatasetMeta()
    try:
        summary = read_json_file(_processed_paths()[0])
        schema_version = summary.get("schema_version") or 1
        source_sha = (summary.get("source") or {}).get("sha256")
        generated = summary.get("generated_at")
        window = summary.get("window") or {}
        recent = window.get("recent_7d") or {}
        previous = window.get("previous_7d") or {}
        source = summary.get("source") or {}
        audit = summary.get("audit") or {}
        fp = source.get("file_path") or ""
        return DatasetMeta(
            ready=True,
            schemaVersion=schema_version,
            generatedAt=generated,
            datasetVersion=f"schema-{schema_version}:{source_sha}" if source_sha else generated,
            sourceSha256=source_sha,
            maxDay=int(window.get("max_day") or 31),
            recentStart=int(recent.get("start_day") or 25),
            recentEnd=int(recent.get("end_day") or 31),
            previousStart=int(previous.get("start_day") or 18),
            previousEnd=int(previous.get("end_day") or 24),
            sourceName=fp.split("/")[-1] if fp else None,
            rowCount=source.get("row_count"),
            conversionMarkerRows=audit.get("conversion_marker_rows"),
            uniqueConversionEvents=audit.get("unique_conversion_events"),
            uniqueAttributedConversionEvents=audit.get("unique_attributed_conversion_events"),
            conversionWithoutClickRows=audit.get("conversion_without_click_rows"),
            fieldMapping=dict(source.get("field_mapping") or {}),
        )
    except Exception:
        return DatasetMeta()


def get_daily_metrics() -> list[dict[str, Any]]:
    if not processed_ready():
        return []
    return [to_daily_metric(r) for r in parse_csv(_processed_paths()[1])]

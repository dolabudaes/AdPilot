from __future__ import annotations

import math
import re

from app.services.analytics import get_campaign_by_id, get_campaigns, get_daily_metrics, get_dataset_meta
from app.services.copilot.diagnostics import sum_daily
from app.services.copilot.labels import ACTION_LABEL, FINDING_LABEL, STATUS_LABEL, format_change, format_cost, format_count, format_rate
from app.services.copilot.service import build_product_model
from app.services.copilot.windows import resolve_window
from app.services.workbench.format import rate, wow

SOURCE = "campaign_daily.csv"


def _query_failed_message(opened: dict) -> str:
    return opened.get("message") or "Query failed"


def open_campaign(campaign_id: str, window_id: str):
    meta = get_dataset_meta()
    window = checked_window(window_id, meta.maxDay, meta.ready)
    if isinstance(window, str):
        return {"message": window}
    campaign = get_campaign_by_id(campaign_id) or next(
        (c for c in get_campaigns() if c.get("display_name", "").lower() == campaign_id.strip().lower()),
        None,
    )
    if not campaign:
        return {"message": f"No campaign named {campaign_id}."}
    rows = [r for r in get_daily_metrics() if r["campaign_id"] == campaign["campaign_id"]]
    if not rows:
        return {"message": f"{campaign['display_name']} has no daily aggregates in the imported dataset."}
    return {"campaign": campaign, "window": window, "meta": meta, "rows": rows}


def checked_window(window_id: str, max_day: int, ready: bool):
    if not ready:
        return "Processed dataset is not ready."
    if window_id != "recent_7d" and not re.match(r"^d\d+-d\d+$", window_id):
        return "Window must use processed relative day ranges."
    meta = get_dataset_meta()
    window = resolve_window(window_id, meta)
    requested = re.match(r"^d(\d+)-d(\d+)$", window_id)
    matches_resolved = (
        window
        and requested
        and window.start == int(requested.group(1))
        and window.end == int(requested.group(2))
    ) or (window and window.id == window_id)
    if not window or not matches_resolved:
        return f"Window is outside the imported dataset (available D1–D{max_day})."
    return window


def _previous_rows(rows: list, window) -> list | None:
    if window.compareStart is None or window.compareEnd is None:
        return None
    return [r for r in rows if window.compareStart <= r["day"] <= window.compareEnd]


def get_campaign_metrics(campaign_id: str, window_id: str):
    opened = open_campaign(campaign_id, window_id)
    if "message" in opened:
        return {"ok": False, "tool": "get_campaign_metrics", "message": _query_failed_message(opened)}
    campaign, window, meta, rows = opened["campaign"], opened["window"], opened["meta"], opened["rows"]
    current = sum_daily([r for r in rows if window.start <= r["day"] <= window.end])
    prev_rows = _previous_rows(rows, window)
    previous = sum_daily(prev_rows) if prev_rows is not None else None
    metrics = [
        count_metric("impressions", "Impressions", current["impressions"], previous["impressions"] if previous else None),
        count_metric("clicks", "Clicks", current["clicks"], previous["clicks"] if previous else None),
        rate_metric(
            "ctr",
            "CTR",
            current["ctr"],
            previous["ctr"] if previous else None,
            current["impressions"],
            previous["impressions"] if previous else None,
        ),
        count_metric("conversions", "Conversion-linked clicks", current["conversions"], previous["conversions"] if previous else None),
        rate_metric(
            "cvr",
            "Post-click conversion-link rate",
            current["cvr"],
            previous["cvr"] if previous else None,
            current["clicks"],
            previous["clicks"] if previous else None,
        ),
        count_metric("attributed", "Attributed conversion links", current["attributed"], previous["attributed"] if previous else None),
        transformed_index_metric("cost", "Cost index total", current["cost"], previous["cost"] if previous else None),
        transformed_index_metric(
            "cost_per_click",
            "Average cost index per click",
            current["costPerClick"],
            previous["costPerClick"] if previous else None,
        ),
    ]
    return {
        "ok": True,
        "tool": "get_campaign_metrics",
        "campaignId": campaign["campaign_id"],
        "campaignName": campaign["display_name"],
        "windowId": window.id,
        "windowLabel": window.label,
        "compareLabel": window.compareLabel,
        "snapshotAt": meta.generatedAt,
        "source": SOURCE,
        "metrics": metrics,
        "citations": [
            cite(campaign["campaign_id"], window.label, window.compareLabel, meta.generatedAt, m)
            for m in metrics
            if m["status"] == "ok"
        ],
    }


def analyze_daily_trend(campaign_id: str, window_id: str, span: str = "both"):
    opened = open_campaign(campaign_id, window_id)
    if "message" in opened:
        return {"ok": False, "tool": "analyze_daily_trend", "message": _query_failed_message(opened)}
    campaign, window, meta, rows = opened["campaign"], opened["window"], opened["meta"], opened["rows"]
    if span == "all":
        start = 1
    elif span == "current":
        start = window.start
    else:
        start = window.compareStart if window.compareStart is not None else window.start
    end = meta.maxDay if span == "all" else window.end
    points = points_for(rows, start, end)
    summary = trend_summary(points, window.start, window.end)
    processed_suffix = f" · Processed {meta.generatedAt}" if meta.generatedAt else ""
    citations = [
        {
            **item,
            "source": f"{SOURCE}{processed_suffix}",
            "windowLabel": window.label,
            "compareLabel": window.compareLabel,
            "campaignId": campaign["campaign_id"],
        }
        for item in summary["citations"]
    ]
    return {
        "ok": True,
        "tool": "analyze_daily_trend",
        "campaignId": campaign["campaign_id"],
        "campaignName": campaign["display_name"],
        "windowLabel": window.label,
        "compareLabel": window.compareLabel,
        "snapshotAt": meta.generatedAt,
        "source": SOURCE,
        "points": points,
        "currentStart": window.start,
        "currentEnd": window.end,
        "compareStart": window.compareStart,
        "compareEnd": window.compareEnd,
        "note": summary["note"],
        "citations": citations,
    }


def compare_campaigns(campaign_ids: list[str], window_id: str):
    unique = list(dict.fromkeys([x.strip() for x in campaign_ids if x.strip()]))
    if len(unique) < 2:
        return {"ok": False, "tool": "compare_campaigns", "message": "At least two existing campaigns are required for comparison."}
    meta = get_dataset_meta()
    window = checked_window(window_id, meta.maxDay, meta.ready)
    if isinstance(window, str):
        return {"ok": False, "tool": "compare_campaigns", "message": window}
    model = build_product_model({"accountId": "criteo-demo", "windowId": window.id})
    rows: list[dict] = []
    citations: list[dict] = []
    for cid in unique:
        metrics = get_campaign_metrics(cid, window.id)
        if not metrics.get("ok"):
            return {"ok": False, "tool": "compare_campaigns", "message": metrics.get("message", "Query failed")}
        clicks = next(m for m in metrics["metrics"] if m["key"] == "clicks")
        conversions = next(m for m in metrics["metrics"] if m["key"] == "conversions")
        cvr = next(m for m in metrics["metrics"] if m["key"] == "cvr")
        ctr = next(m for m in metrics["metrics"] if m["key"] == "ctr")
        finding = next((f for f in model["findings"] if f["campaignId"] == metrics["campaignId"]), None)
        signal_metric = cvr
        rows.append(
            {
                "campaignId": metrics["campaignId"],
                "campaignName": metrics["campaignName"],
                "clicks": clicks["current"] or 0,
                "conversions": conversions["current"] or 0,
                "cvr": cvr["current"] if cvr["status"] == "ok" else None,
                "ctr": ctr["current"] if ctr["status"] == "ok" else None,
                "cvrRelativePct": cvr.get("relativePct"),
                "cvrPointChange": cvr.get("pointChange"),
                "clicksRelativePct": clicks.get("relativePct"),
                "conversionsRelativePct": conversions.get("relativePct"),
                "findingType": finding["type"] if finding else None,
                "severity": finding["severity"] if finding else None,
                "signalLabel": "Post-click conversion-link rate",
                "signalMetric": "cvr",
                "signalValue": format_rate(signal_metric.get("current")),
                "signalRelativePct": signal_metric.get("relativePct"),
                "signalTone": "opportunity" if finding and finding.get("type") == "scale_opportunity" else "risk",
            }
        )
        for metric_key in ("clicks", "conversions", "cvr"):
            citation = next((x for x in metrics["citations"] if x.get("metric") == metric_key), None)
            if citation:
                citations.append(citation)
    return {
        "ok": True,
        "tool": "compare_campaigns",
        "windowId": window.id,
        "windowLabel": window.label,
        "compareLabel": window.compareLabel,
        "snapshotAt": meta.generatedAt,
        "source": SOURCE,
        "rows": rows,
        "citations": citations,
    }


def analyze_attribution(campaign_id: str, window_id: str):
    opened = open_campaign(campaign_id, window_id)
    if "message" in opened:
        return {"ok": False, "tool": "analyze_attribution", "message": _query_failed_message(opened)}
    campaign, window, meta, rows = opened["campaign"], opened["window"], opened["meta"], opened["rows"]
    current = sum_daily([r for r in rows if window.start <= r["day"] <= window.end])
    prev_rows = _previous_rows(rows, window)
    previous = sum_daily(prev_rows) if prev_rows is not None else None
    share = current["attributed"] / current["conversions"] if current["conversions"] > 0 else None
    prev_share = previous["attributed"] / previous["conversions"] if previous and previous["conversions"] > 0 else None
    share_point_change = (share - prev_share) * 100 if share is not None and prev_share is not None else None
    if share is None:
        note = "This window has no conversion-linked clicks, so attribution-link share cannot be compared."
    else:
        comparison = (
            f"The comparison window is {format_rate(prev_share)}. " if prev_share is not None else ""
        )
        note = (
            f"Attributed conversion links are {format_rate(share)} of conversion-linked clicks in this window. "
            f"{comparison}"
            "This is a row-label share, not a unique conversion-event attribution rate."
        )
    relative_points = None
    if share_point_change is not None:
        sign = "+" if share_point_change > 0 else ""
        relative_points = f"{sign}{share_point_change:.2f} percentage points"
    citations = [
        {
            "id": f"attr:{campaign['campaign_id']}:{window.label}:share",
            "label": "Attribution share",
            "value": "Unavailable" if share is None else format_rate(share),
            "baseline": None if prev_share is None else format_rate(prev_share),
            "absolute": None,
            "relative": relative_points,
            "points": None,
            "source": f"{SOURCE} · {meta.generatedAt or ''}",
            "windowLabel": window.label,
            "compareLabel": window.compareLabel,
            "campaignId": campaign["campaign_id"],
            "metric": "attribution_share",
        }
    ]
    return {
        "ok": True,
        "tool": "analyze_attribution",
        "campaignId": campaign["campaign_id"],
        "campaignName": campaign["display_name"],
        "windowId": window.id,
        "windowLabel": window.label,
        "compareLabel": window.compareLabel,
        "snapshotAt": meta.generatedAt,
        "source": SOURCE,
        "conversions": current["conversions"],
        "attributed": current["attributed"],
        "previousConversions": previous["conversions"] if previous else None,
        "previousAttributed": previous["attributed"] if previous else None,
        "attributionShare": share,
        "previousAttributionShare": prev_share,
        "sharePointChange": share_point_change,
        "note": note,
        "citations": citations,
    }


def detect_anomalous_days(campaign_id: str, window_id: str):
    opened = open_campaign(campaign_id, window_id)
    if "message" in opened:
        return {"ok": False, "tool": "detect_anomalous_days", "message": _query_failed_message(opened)}
    campaign, window, meta, rows = opened["campaign"], opened["window"], opened["meta"], opened["rows"]
    points = points_for(rows, window.start, window.end)
    usable = [p for p in points if p["clicks"] >= 40 and p.get("cvr") is not None]
    days: list[dict] = []
    if len(usable) >= 4:
        mean = sum(p["cvr"] or 0 for p in usable) / len(usable)
        variance = sum(((p["cvr"] or 0) - mean) ** 2 for p in usable) / len(usable)
        sd = math.sqrt(variance)
        for point in usable:
            z = ((point["cvr"] or 0) - mean) / sd if sd >= 0.003 else None
            notable = z is not None and z <= -1.6
            days.append(
                {
                    "day": point["day"],
                    "metric": "cvr",
                    "z": round(z, 2) if z is not None else None,
                    "fact": f"D{point['day']}: {format_count(point['clicks'])} clicks, post-click conversion-link rate {format_rate(point['cvr'])}.",
                    "notable": notable,
                }
            )
    flagged = sorted([d for d in days if d.get("notable")], key=lambda d: d.get("z") or 0)[:4]
    if not flagged:
        note = "No day in this window reached the deviation threshold. Normal variation is not labeled as an anomaly."
    else:
        note = (
            f"{len(flagged)} day(s) had a post-click conversion-link rate materially below the campaign-window mean. "
            "This is a statistical flag, not a root cause."
        )
    anomaly_citations = [
        {
            "id": f"anomaly:{campaign['campaign_id']}:d{item['day']}",
            "label": f"D{item['day']} post-click conversion-link rate",
            "value": item["fact"],
            "baseline": None,
            "absolute": None if item["z"] is None else f"z {item['z']}",
            "relative": None,
            "points": None,
            "source": SOURCE,
            "windowLabel": window.label,
            "compareLabel": window.compareLabel,
            "campaignId": campaign["campaign_id"],
            "metric": "cvr",
        }
        for item in flagged
    ]
    return {
        "ok": True,
        "tool": "detect_anomalous_days",
        "campaignId": campaign["campaign_id"],
        "campaignName": campaign["display_name"],
        "windowLabel": window.label,
        "compareLabel": window.compareLabel,
        "snapshotAt": meta.generatedAt,
        "source": SOURCE,
        "days": flagged if flagged else days[:7],
        "note": note,
        "citations": anomaly_citations,
    }


def retrieve_decision_history(account_id: str, window_id: str, finding_id: str | None, campaign_id: str):
    model = build_product_model({"accountId": account_id, "windowId": window_id})
    if finding_id:
        finding = next((f for f in model["findings"] if f["id"] == finding_id), None)
    else:
        finding = next((f for f in model["findings"] if f["campaignId"] == campaign_id), None)
    if not finding:
        return {
            "ok": False,
            "tool": "retrieve_decision_history",
            "message": "No finding or decision record was found for this campaign in the current window.",
        }
    entries: list[dict] = [
        {
            "kind": "finding",
            "label": FINDING_LABEL.get(finding["type"], finding["type"]),
            "detail": finding["interpretation"],
            "status": finding["severity"],
            "readOnly": True,
        }
    ]
    if finding.get("recommendation"):
        rec = finding["recommendation"]
        entries.append(
            {
                "kind": "recommendation",
                "label": ACTION_LABEL[rec["proposal"]["actionType"]],
                "detail": rec["proposal"]["reason"],
                "status": STATUS_LABEL.get(rec["status"], rec["status"]),
                "readOnly": True,
            }
        )
        if rec.get("decisionId"):
            entries.append(
                {
                    "kind": "decision",
                    "label": "Human decision",
                    "detail": f"Decision ID {rec['decisionId']}",
                    "status": STATUS_LABEL.get(rec["status"], rec["status"]),
                    "readOnly": True,
                }
            )
    return {
        "ok": True,
        "tool": "retrieve_decision_history",
        "campaignId": finding["campaignId"],
        "campaignName": finding["campaignName"],
        "findingId": finding["id"],
        "windowLabel": finding["windowLabel"],
        "entries": entries,
        "note": "Read-only history. A conversation cannot change Exported or externally declared execution status.",
    }


def count_metric(key: str, label: str, current: float, previous: float | None):
    return {
        "key": key,
        "label": label,
        "current": current,
        "previous": previous,
        "absolute": None if previous is None else current - previous,
        "relativePct": wow(current, previous),
        "pointChange": None,
        "status": "ok",
        "reason": None,
    }


def index_metric(key: str, label: str, current: float | None, previous: float | None, denominator: float):
    if current is None or denominator == 0:
        return {
            "key": key,
            "label": label,
            "current": None,
            "previous": previous,
            "absolute": None,
            "relativePct": None,
            "pointChange": None,
            "status": "unavailable",
            "reason": "The denominator is zero or missing, so this metric cannot be calculated.",
        }
    return {
        "key": key,
        "label": label,
        "current": current,
        "previous": previous,
        "absolute": None if previous is None else current - previous,
        "relativePct": wow(current, previous),
        "pointChange": None,
        "status": "ok",
        "reason": None,
    }


def transformed_index_metric(key: str, label: str, current: float | None, previous: float | None):
    if current is None:
        return {
            "key": key,
            "label": label,
            "current": None,
            "previous": previous,
            "absolute": None,
            "relativePct": None,
            "pointChange": None,
            "status": "unavailable",
            "reason": "The transformed cost index is missing.",
        }
    return {
        "key": key,
        "label": label,
        "current": current,
        "previous": previous,
        "absolute": None if previous is None else current - previous,
        "relativePct": None,
        "pointChange": None,
        "status": "ok",
        "reason": "The source does not disclose a ratio-scale cost transform, so percentage improvement or deterioration is not reported.",
    }


def rate_metric(
    key: str,
    label: str,
    current: float | None,
    previous: float | None,
    current_denom: float,
    previous_denom: float | None,
):
    if current is None or current_denom == 0:
        return {
            "key": key,
            "label": label,
            "current": None,
            "previous": previous,
            "absolute": None,
            "relativePct": None,
            "pointChange": None,
            "status": "unavailable",
            "reason": "The denominator is zero or missing, so this metric cannot be calculated.",
        }
    return {
        "key": key,
        "label": label,
        "current": current,
        "previous": previous if previous_denom else None,
        "absolute": None,
        "relativePct": wow(current, previous) if previous_denom else None,
        "pointChange": (current - previous) * 100 if previous is not None and previous_denom else None,
        "status": "ok",
        "reason": None,
    }


def cite(campaign_id: str, window_label: str, compare_label: str | None, snapshot_at: str | None, metric: dict):
    shown = present(metric)
    return {
        "id": f"metric:{campaign_id}:{window_label}:{metric['key']}",
        "label": metric["label"],
        "value": shown["value"],
        "baseline": shown["baseline"],
        "absolute": shown["absolute"],
        "relative": shown["relative"],
        "points": shown["points"],
        "source": f"{SOURCE}{f' · Processed {snapshot_at}' if snapshot_at else ''}",
        "windowLabel": window_label,
        "compareLabel": compare_label,
        "campaignId": campaign_id,
        "metric": metric["key"],
    }


def present(metric: dict):
    rate_key = metric["key"] in ("ctr", "cvr")
    cost_key = metric["key"] in ("cost", "cost_per_click")

    def fmt(value: float | None):
        if rate_key:
            return format_rate(value)
        if cost_key:
            return format_cost(value)
        return format_count(value)

    absolute = None
    if metric["absolute"] is not None:
        sign = "+" if metric["absolute"] > 0 else "-" if metric["absolute"] < 0 else ""
        magnitude = format_cost(abs(metric["absolute"])) if cost_key else format_count(abs(metric["absolute"]))
        absolute = f"{sign}{magnitude}"

    points = None
    if metric.get("pointChange") is not None:
        pc = metric["pointChange"]
        sign = "+" if pc > 0 else ""
        points = f"{sign}{pc:.2f} percentage points"

    return {
        "value": fmt(metric["current"]),
        "baseline": None if metric["previous"] is None else fmt(metric["previous"]),
        "absolute": absolute,
        "relative": None if metric["relativePct"] is None else format_change(metric["relativePct"]),
        "points": points,
    }


def points_for(rows: list, start: int, end: int):
    days: dict[int, list] = {}
    for row in rows:
        if row["day"] < start or row["day"] > end:
            continue
        days.setdefault(row["day"], []).append(row)
    out = []
    for day in sorted(days.keys()):
        grouped = days[day]
        summed = sum_daily(grouped)
        out.append(
            {
                "day": day,
                "impressions": summed["impressions"],
                "clicks": summed["clicks"],
                "conversions": summed["conversions"],
                "attributed": summed["attributed"],
                "cost": summed["cost"],
                "ctr": summed["ctr"],
                "cvr": rate(summed["conversions"], summed["clicks"]),
            }
        )
    return out


def trend_summary(points: list, start: int, end: int):
    recent = [p for p in points if start <= p["day"] <= end and p["clicks"] > 0]
    if len(recent) < 2:
        return {
            "note": "This window has too few computable daily samples to determine whether the change persisted.",
            "citations": [],
        }
    prior = [p for p in points if p["day"] < start and p["clicks"] > 0]
    current_conversions = sum(p["conversions"] for p in recent)
    current_clicks = sum(p["clicks"] for p in recent)
    prior_conversions = sum(p["conversions"] for p in prior)
    prior_clicks = sum(p["clicks"] for p in prior)
    prior_cvr = rate(prior_conversions, prior_clicks)
    current_cvr = rate(current_conversions, current_clicks)
    above_prior = (
        None
        if prior_cvr is None
        else len([p for p in recent if p.get("cvr") is not None and p["cvr"] > prior_cvr])
    )
    top_day = max(recent, key=lambda p: p["conversions"])
    top_day_share = top_day["conversions"] / current_conversions if current_conversions > 0 else None
    if above_prior is None:
        persistence = "No prior-window aggregate is available for a daily persistence comparison."
    else:
        persistence = (
            f"{above_prior} of {len(recent)} days were above the prior-window aggregate "
            f"post-click conversion-link rate of {format_rate(prior_cvr)}."
        )
    if top_day_share is None:
        concentration = "Daily conversion concentration is not computable."
    else:
        concentration = (
            f"The top day, D{top_day['day']}, accounted for {top_day_share * 100:.1f}% of "
            "current-window conversion-linked clicks."
        )
    if above_prior is not None and above_prior >= math.ceil(len(recent) * 0.7):
        shape = "The change was broad across the selected window rather than confined to one date."
    else:
        shape = "The aggregate change was uneven across the selected window, so daily variation remains material."
    note = (
        f"{persistence} {concentration} {shape} D labels are relative days, not calendar dates. "
        "These daily aggregates support a timing assessment, not a causal explanation."
    )
    citations = [
        {
            "id": f"trend:persistence:d{start}-d{end}",
            "label": "Days above prior-window aggregate conversion-link rate",
            "value": "Unavailable" if above_prior is None else f"{above_prior} of {len(recent)} days",
            "baseline": None if prior_cvr is None else format_rate(prior_cvr),
            "absolute": None,
            "relative": None if current_cvr is None or prior_cvr is None else format_change(wow(current_cvr, prior_cvr)),
            "points": None,
            "source": SOURCE,
            "windowLabel": f"D{start}–D{end}",
            "compareLabel": None,
            "campaignId": "",
            "metric": "daily_cvr_persistence",
        },
        {
            "id": f"trend:concentration:d{start}-d{end}",
            "label": "Top-day conversion-linked-click share",
            "value": "Unavailable" if top_day_share is None else f"{top_day_share * 100:.1f}%",
            "baseline": None,
            "absolute": f"D{top_day['day']}",
            "relative": None,
            "points": None,
            "source": SOURCE,
            "windowLabel": f"D{start}–D{end}",
            "compareLabel": None,
            "campaignId": "",
            "metric": "daily_conversion_concentration",
        },
    ]
    return {"note": note, "citations": citations}

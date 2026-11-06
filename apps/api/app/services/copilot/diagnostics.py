from __future__ import annotations

from app.services.copilot.labels import format_change, format_count, format_rate
from app.services.copilot.signal_rules import SIGNAL_RULES
from app.services.copilot.windows import WindowSpec
from app.services.copilot.metrics import relative_change
from app.services.workbench.format import rate, wow

DEMO_ACCOUNT_ID = "criteo-demo"

MISSING = [
    "Budget, bid, and verified ad-spend fields are unavailable, so the snapshot cannot support delivery-change recommendations.",
    "Creative, landing-page, and audience fields are unavailable, so efficiency movement cannot be attributed to those factors.",
    "Cost is an undisclosed transformed index; it is not currency and cannot support percentage claims of cost improvement or deterioration.",
]


def load_analysis_inputs():
    from app.services.analytics import get_campaigns, get_daily_metrics

    return {"campaigns": get_campaigns(), "daily": get_daily_metrics()}


def sum_daily(rows: list[dict]) -> dict:
    return bucket(rows)


def bucket(rows: list[dict]) -> dict:
    impressions = sum(r.get("impressions", 0) for r in rows)
    clicks = sum(r.get("clicks", 0) for r in rows)
    conversions = sum(r.get("conversions", 0) for r in rows)
    attributed = sum(r.get("attributed_conversions", 0) for r in rows)
    cost = sum(r.get("total_cost", 0) for r in rows)
    return {
        "impressions": impressions,
        "clicks": clicks,
        "conversions": conversions,
        "attributed": attributed,
        "cost": cost,
        "ctr": rate(clicks, impressions),
        "cvr": rate(conversions, clicks),
        "costPerClick": cost / clicks if clicks else None,
        "attributionShare": rate(attributed, conversions),
    }


def diagnose(input_data: dict) -> dict:
    from app.services.copilot.labels import FINDING_LABEL, delta_tone

    window: WindowSpec = input_data["window"]
    min_clicks = max(20, input_data.get("minClicks") or 80)
    source = f"campaign_daily.csv · {window.label}"
    by_campaign: dict[str, list] = {}
    for row in input_data["daily"]:
        by_campaign.setdefault(row["campaign_id"], []).append(row)

    pairs = []
    for campaign in input_data["campaigns"]:
        rows = by_campaign.get(campaign["campaign_id"], [])
        current = bucket([r for r in rows if window.start <= r["day"] <= window.end])
        previous = None
        if window.compareStart is not None and window.compareEnd is not None:
            previous = bucket([r for r in rows if window.compareStart <= r["day"] <= window.compareEnd])
        pairs.append({"campaign": campaign, "rows": rows, "current": current, "previous": previous})

    account_current = bucket([r for r in input_data["daily"] if window.start <= r["day"] <= window.end])
    account_previous = None
    if window.compareStart is not None and window.compareEnd is not None:
        account_previous = bucket(
            [r for r in input_data["daily"] if window.compareStart <= r["day"] <= window.compareEnd]
        )

    findings = []
    for pair in pairs:
        f = classify(
            {
                "accountId": input_data["accountId"],
                "window": window,
                "campaign": pair["campaign"],
                "current": pair["current"],
                "previous": pair["previous"],
                "accountCvr": account_current["cvr"],
                "minClicks": min_clicks,
                "source": source,
            }
        )
        if f:
            findings.append(f)

    rank = {"high": 0, "medium": 1, "low": 2, "info": 3}
    findings.sort(
        key=lambda a: (
            rank[a["severity"]],
            -abs(a["raw"].get("conversionDelta") or 0),
        )
    )
    primary = [f for f in findings if f["severity"] != "info"]
    info = [f for f in findings if f["severity"] == "info"][:6]
    visible = primary + info
    primary_ids = {f["campaignId"] for f in primary}

    watchlist = []
    for pair in pairs:
        if not pair["previous"] or pair["campaign"]["campaign_id"] in primary_ids:
            continue
        if pair["current"]["clicks"] < min_clicks or pair["previous"]["clicks"] < min_clicks:
            continue
        delta = pair["current"]["conversions"] - pair["previous"]["conversions"]
        if delta >= 0:
            continue
        watchlist.append(
            {
                "campaignId": pair["campaign"]["campaign_id"],
                "campaignName": pair["campaign"]["display_name"],
                "conversionDelta": delta,
                "fact": f"{pair['campaign']['display_name']} had {format_count(abs(delta))} fewer conversion-linked clicks, but its post-click conversion-link rate changed {format_change(wow(pair['current']['cvr'], pair['previous']['cvr']))}; the combined anomaly and sample thresholds were not met.",
            }
        )
    watchlist.sort(key=lambda w: w["conversionDelta"])
    watchlist = watchlist[:3]

    trend = account_trend(input_data["daily"], window)
    anomalies = cvr_anomalies(trend)
    kpis = build_kpis(account_current, account_previous, trend, visible)
    campaigns = sorted(
        [to_stats(p["campaign"], p["current"], p["rows"], window) for p in pairs],
        key=lambda c: c["impressions"],
        reverse=True,
    )
    return {
        "findings": visible,
        "watchlist": watchlist,
        "kpis": kpis,
        "trend": trend,
        "anomalies": anomalies,
        "campaigns": campaigns,
        "missing": MISSING,
    }


def classify(input_data: dict):
    campaign = input_data["campaign"]
    current = input_data["current"]
    previous = input_data["previous"]
    window = input_data["window"]
    if current["impressions"] <= 0 and current["clicks"] <= 0:
        return None
    raw = to_raw(current, previous)
    base = {
        "accountId": input_data["accountId"],
        "campaignId": campaign["campaign_id"],
        "campaignName": campaign["display_name"],
        "windowId": window.id,
        "windowLabel": window.label,
        "compareLabel": window.compareLabel,
        "source": input_data["source"],
        "raw": raw,
        "current": current,
        "previous": previous,
    }
    min_clicks = input_data["minClicks"]
    account_cvr = input_data["accountCvr"]

    if not previous:
        if current["impressions"] >= 2000 and current["clicks"] < min_clicks:
            return draft(base, "data_gap", "info", "Comparison window is unavailable")
        if (
            account_cvr is not None
            and current["clicks"] >= SIGNAL_RULES["benchmarkMinClicks"]
            and current["cvr"] is not None
            and current["cvr"] <= account_cvr * SIGNAL_RULES["weakAccountBenchmarkRatio"]
            and current["cvr"] <= SIGNAL_RULES["weakRateCeiling"]
        ):
            return draft(base, "weak_click_efficiency", "medium", "Conversion-link rate trails the project benchmark")
        return None

    if (current["clicks"] < min_clicks or previous["clicks"] < min_clicks) and current["impressions"] >= 2000:
        return draft(base, "data_gap", "info", "Click sample is below the diagnostic threshold")
    if current["clicks"] < min_clicks or previous["clicks"] < min_clicks:
        return None

    cvr_change = raw["cvrChangePct"]
    cvr_drop = (current["cvr"] - previous["cvr"]) if current["cvr"] is not None and previous["cvr"] is not None else None
    if (
        cvr_change is not None
        and cvr_drop is not None
        and cvr_change <= SIGNAL_RULES["declineRelativePct"]
        and cvr_drop <= SIGNAL_RULES["declineAbsolutePoints"]
        and (raw.get("conversionDelta") or 0) < 0
    ):
        high = (
            cvr_change <= SIGNAL_RULES["highDeclineRelativePct"]
            and current["clicks"] >= SIGNAL_RULES["highDeclineMinClicks"]
            and (raw.get("conversionDelta") or 0) <= SIGNAL_RULES["highDeclineConversionDelta"]
        )
        return draft(
            base,
            "cvr_anomaly",
            "high" if high else "medium",
            "Conversion-link rate declined materially" if high else "Conversion-link rate is below the comparison window",
        )

    if (
        account_cvr is not None
        and current["clicks"] >= SIGNAL_RULES["benchmarkMinClicks"]
        and current["cvr"] is not None
        and current["cvr"] <= account_cvr * SIGNAL_RULES["weakAccountBenchmarkRatio"]
        and current["cvr"] <= SIGNAL_RULES["weakRateCeiling"]
    ):
        return draft(base, "weak_click_efficiency", "medium", "Click volume is sufficient but conversion-link efficiency is weak")

    if (
        current["conversions"] >= 30
        and previous["conversions"] >= 30
        and current["attributionShare"] is not None
        and previous["attributionShare"] is not None
        and (wow(current["attributionShare"], previous["attributionShare"]) or 0) <= SIGNAL_RULES["attributionRelativePct"]
    ):
        return draft(base, "attribution_anomaly", "low", "Attribution-link share declined versus the comparison window")

    if (
        current["clicks"] >= SIGNAL_RULES["benchmarkMinClicks"]
        and previous["clicks"] >= SIGNAL_RULES["benchmarkMinClicks"]
        and cvr_change is not None
        and cvr_drop is not None
        and cvr_change >= SIGNAL_RULES["opportunityRelativePct"]
        and cvr_drop >= SIGNAL_RULES["opportunityAbsolutePoints"]
        and (raw.get("conversionDelta") or 0) > 0
        and account_cvr is not None
        and current["cvr"] is not None
        and current["cvr"] >= account_cvr
    ):
        return draft(base, "scale_opportunity", "medium", "Conversion-link efficiency improved versus the comparison window")
    return None


def to_raw(current: dict, previous: dict | None) -> dict:
    return {
        "clicks": current["clicks"],
        "previousClicks": previous["clicks"] if previous else None,
        "cvr": current["cvr"],
        "previousCvr": previous["cvr"] if previous else None,
        "cvrChangePct": relative_change(current["cvr"], previous["cvr"]) if previous else None,
        "conversions": current["conversions"],
        "previousConversions": previous["conversions"] if previous else None,
        "conversionDelta": current["conversions"] - previous["conversions"] if previous else None,
        "clicksChangePct": wow(current["clicks"], previous["clicks"]) if previous else None,
        "costPerClickChangePct": wow(current["costPerClick"], previous["costPerClick"]) if previous else None,
    }


def draft(base: dict, ftype: str, severity: str, title_tail: str) -> dict:
    from app.services.copilot.labels import FINDING_LABEL

    name = base["campaignName"]
    current = base["current"]
    previous = base["previous"]
    raw = base["raw"]
    evidence = [
        item("Clicks", format_count(current["clicks"]), format_count(previous["clicks"]) if previous else None, format_change(raw.get("clicksChangePct")), base["source"]),
        item(
            "Conversion-linked clicks",
            format_count(current["conversions"]),
            format_count(previous["conversions"]) if previous else None,
            format_count(raw["conversionDelta"]) if raw.get("conversionDelta") is not None else None,
            base["source"],
        ),
        item(
            "Post-click conversion-link rate",
            format_rate(current["cvr"]),
            format_rate(previous["cvr"]) if previous else None,
            format_change(raw.get("cvrChangePct")),
            base["source"],
        ),
    ]
    fact = f"{name} recorded {format_count(current['clicks'])} clicks in {base['windowLabel']}; {format_count(current['conversions'])} clicks carried a future 30-day conversion label, for a post-click conversion-link rate of {format_rate(current['cvr'])}. "
    if previous:
        fact += f"The comparison window recorded {format_count(previous['clicks'])} clicks, {format_count(previous['conversions'])} conversion-linked clicks, and a {format_rate(previous['cvr'])} conversion-link rate."
    else:
        fact += "No equal-length comparison window is available."
    interpretation_map = {
        "cvr_anomaly": "Post-click conversion-link rate moved beyond the rule threshold while conversion-linked clicks also fell. Judged against this campaign's comparison window.",
        "weak_click_efficiency": "Click volume is sufficient, but post-click conversion-link rate trails the project benchmark and an 8% absolute floor.",
        "cost_rise": "Cost index per click rose without a matching CVR gain. Cost index is not verified ad spend.",
        "scale_opportunity": "Post-click conversion-link rate beats its own baseline and the project benchmark. This supports further efficiency validation, not an automatic budget or delivery increase.",
        "attribution_anomaly": "Attribution-link share fell—an attribution-mix signal, not an independent conversion-event conclusion.",
    }
    interpretation = interpretation_map.get(ftype, "Sample or comparison window is too thin for a firm optimization call.")
    hypothesis = "Budget, bids, creatives, and landing pages are not in this dataset; those angles remain unverified hypotheses."
    return {
        "id": f"finding:{base['accountId']}:{base['windowId']}:{base['campaignId']}:{ftype}",
        "accountId": base["accountId"],
        "campaignId": base["campaignId"],
        "campaignName": name,
        "type": ftype,
        "severity": severity,
        "windowId": base["windowId"],
        "windowLabel": base["windowLabel"],
        "compareLabel": base["compareLabel"],
        "title": f"{name}: {title_tail}",
        "summary": f"{FINDING_LABEL[ftype]}. {fact}",
        "fact": fact,
        "interpretation": interpretation,
        "hypothesis": hypothesis,
        "evidence": evidence,
        "raw": raw,
    }


def item(label, value, baseline, delta, source):
    return {"label": label, "value": value, "baseline": baseline, "delta": delta, "source": source}


def account_trend(daily: list[dict], window: WindowSpec) -> list[dict]:
    buckets: dict[int, list] = {}
    for row in daily:
        if row["day"] < window.start or row["day"] > window.end:
            continue
        buckets.setdefault(row["day"], []).append(row)
    out = []
    for day in sorted(buckets):
        summed = bucket(buckets[day])
        out.append(
            {
                "day": day,
                "impressions": summed["impressions"],
                "clicks": summed["clicks"],
                "conversions": summed["conversions"],
                "attributed": summed["attributed"],
                "cost": summed["cost"],
                "ctr": summed["ctr"],
                "cvr": summed["cvr"],
            }
        )
    return out


def cvr_anomalies(trend: list[dict]) -> list[dict]:
    from app.services.copilot.labels import format_count, format_rate

    usable = [p for p in trend if p["clicks"] >= 100 and p["cvr"] is not None]
    if len(usable) < 8:
        return []
    mean = sum(p["cvr"] for p in usable) / len(usable)
    variance = sum((p["cvr"] - mean) ** 2 for p in usable) / len(usable)
    sd = variance**0.5
    if sd < 0.004:
        return []
    flagged = []
    for p in usable:
        z = (p["cvr"] - mean) / sd
        if z <= -2:
            flagged.append(
                {
                    "day": p["day"],
                    "metric": "cvr",
                    "z": round(z, 2),
                    "title": f"D{p['day']} post-click conversion-link rate below window mean",
                    "fact": (
                        f"On D{p['day']} the account post-click conversion-link rate was {format_rate(p['cvr'])}, "
                        f"about {abs(z):.1f} standard deviations below the window mean. "
                        f"Clicks that day: {format_count(p['clicks'])}. "
                        "This flags a statistical deviation—not a specific campaign cut."
                    ),
                }
            )
    flagged.sort(key=lambda x: x["z"])
    return flagged[:3]


def build_kpis(current, previous, trend, findings) -> list[dict]:
    from app.services.copilot.labels import delta_tone, format_change, format_cost, format_count, format_rate

    def related(ftype):
        return next((f["id"] for f in findings if f["type"] == ftype), None)

    rows = [
        ("impressions", "Impressions", "impressions", current["impressions"], previous["impressions"] if previous else None, "Ad impressions in the window.", None, False, False),
        ("clicks", "Clicks", "clicks", current["clicks"], previous["clicks"] if previous else None, "Clicks in the window.", related("weak_click_efficiency"), False, False),
        ("ctr", "CTR", "ctr", current["ctr"], previous["ctr"] if previous else None, "Clicks / impressions.", None, True, False),
        ("conversions", "Conversion-linked clicks", "conversions", current["conversions"], previous["conversions"] if previous else None, "Clicks that received a future 30-day conversion label in this log snapshot. Not confirmed purchases or revenue.", related("cvr_anomaly"), False, False),
        ("cvr", "Conversion-link rate", "cvr", current["cvr"], previous["cvr"] if previous else None, "Share of clicks with a future 30-day conversion label in this window. Not live platform CVR or ROI.", related("cvr_anomaly") or related("weak_click_efficiency"), True, False),
        ("attributed", "Attributed conversion links", "attributed", current["attributed"], previous["attributed"] if previous else None, "Conversion links attributed to campaigns.", related("attribution_anomaly"), False, False),
        ("cost", "Cost index", "cost", current["cost"], previous["cost"] if previous else None, "Log cost index—not ad spend or budget.", related("cost_rise"), False, True),
    ]
    kpis = []
    for rid, label, metric, value, prev, hint, fid, is_rate, is_cost in rows:
        change = wow(value, prev)
        kpis.append(
            {
                "id": rid,
                "label": label,
                "metric": metric,
                "value": format_rate(value) if is_rate else format_cost(value) if is_cost else format_count(value),
                "delta": format_change(change),
                "deltaTone": delta_tone(metric, change),
                "hint": hint,
                "spark": [p[metric] for p in trend],
                "findingId": fid,
            }
        )
    return kpis


def to_stats(campaign, current, rows, window: WindowSpec) -> dict:
    series = sorted([r for r in rows if window.start <= r["day"] <= window.end], key=lambda r: r["day"])
    return {
        "id": campaign["campaign_id"],
        "name": campaign["display_name"],
        "impressions": current["impressions"],
        "clicks": current["clicks"],
        "ctr": current["ctr"],
        "conversions": current["conversions"],
        "cvr": current["cvr"],
        "attributed": current["attributed"],
        "cost": current["cost"],
        "spark": [rate(r["conversions"], r["clicks"]) for r in series],
    }


def campaign_series(campaign_id: str, window: WindowSpec, daily=None) -> list[dict]:
    from app.services.analytics import get_daily_metrics

    daily = daily if daily is not None else get_daily_metrics()
    rows = [r for r in daily if r["campaign_id"] == campaign_id and window.start <= r["day"] <= window.end]
    return account_trend(rows, window)

from __future__ import annotations

import re
from typing import Any

from app.services.copilot.investigate.presentation import attach_presentation, performance_finding_lead
from app.services.copilot.labels import ACTION_LABEL, FINDING_LABEL, STATUS_LABEL, format_rate

SECTION = {
    "found": "What We Found",
    "explain": "Possible Explanations",
    "cannot": "What We Cannot Determine",
    "next": "Recommended Next Steps",
}


def narrate_investigation(question: str, results: list[dict], finding: dict | None, conversation_history: list[dict] | None = None) -> dict:
    kind = classify_question(question)
    metrics = next((r for r in results if r.get("ok") and r.get("tool") == "get_campaign_metrics"), None)
    trend = next((r for r in results if r.get("ok") and r.get("tool") == "analyze_daily_trend"), None)
    compare = next((r for r in results if r.get("ok") and r.get("tool") == "compare_campaigns"), None)
    attribution = next((r for r in results if r.get("ok") and r.get("tool") == "analyze_attribution"), None)
    anomalies = next((r for r in results if r.get("ok") and r.get("tool") == "detect_anomalous_days"), None)
    history = next((r for r in results if r.get("ok") and r.get("tool") == "retrieve_decision_history"), None)

    cannot = [
        "Creative, landing page, audience, and verified ad spend fields are not in this imported dataset.",
        "Cost is an undisclosed transformed index, not currency spend, CPA, ROAS, or ROI; percentage improvement is not inferred from it.",
    ]
    found: list[str] = []
    explanations: list[str] = []
    next_steps: list[str] = []

    if history and history.get("ok") and history.get("tool") == "retrieve_decision_history":
        rule = next((e for e in history.get("entries", []) if e.get("kind") == "finding"), None)
        if rule:
            found.append(f"Rule signal: {rule['detail']}")
        rec = next((e for e in history.get("entries", []) if e.get("kind") == "recommendation"), None)
        if rec:
            found.append(f"Recommendation status: {rec['status']} ({rec['label']}).")
    elif finding and kind not in ("unsupported", "account_attention"):
        found.append(f"Flagged as {FINDING_LABEL.get(finding['type'], finding['type'])}: {finding['interpretation']}")

    if trend and trend.get("ok") and trend.get("tool") == "analyze_daily_trend":
        found.append(trend["note"])
    if compare and compare.get("ok") and compare.get("tool") == "compare_campaigns":
        for row in compare.get("rows", []):
            rel = row.get("signalRelativePct")
            if rel is None:
                change = "no comparison baseline"
            else:
                change = f"{rel:+.1f}%" if rel > 0 else f"{rel:.1f}%"
            tone = "Opportunity" if row.get("signalTone") == "opportunity" else "Risk"
            sev = f" · {title_case(row['severity'])} priority" if row.get("severity") else ""
            found.append(
                f"{row['campaignName']}: {row.get('signalLabel')} {row.get('signalValue')}, {change}; {tone}{sev}."
            )
        if kind != "account_attention":
            rows = compare.get("rows", [])
            same = all((r.get("cvrRelativePct") or 0) < 0 for r in rows) or all((r.get("cvrRelativePct") or 0) > 0 for r in rows)
            found.append(
                "Compared campaigns moved in the same conversion-link-rate direction."
                if same
                else "Compared campaigns did not move in the same conversion-link-rate direction."
            )
        cannot.append("Same-window comparison does not establish a shared root cause.")
        found.append(f"Window: {compare['windowLabel']}")
    if attribution and attribution.get("ok") and attribution.get("tool") == "analyze_attribution":
        found.append(attribution["note"])
        cannot.append("Path-level attribution mechanics cannot be inferred from daily aggregates alone.")
    if anomalies and anomalies.get("ok") and anomalies.get("tool") == "detect_anomalous_days":
        found.append(anomalies["note"])
        if len([d for d in anomalies.get("days", []) if d.get("notable")]) == 0:
            cannot.append("Daily sample size or deviation is insufficient to flag notable anomaly days.")

    append_unsupported_cannot(question, cannot)

    cvr_metric = None
    if metrics and metrics.get("ok") and metrics.get("tool") == "get_campaign_metrics":
        cvr_metric = next((m for m in metrics.get("metrics", []) if m.get("key") == "cvr"), None)
    has_comparison = bool(cvr_metric and cvr_metric.get("previous") is not None and cvr_metric.get("status") == "ok")

    if metrics and metrics.get("ok") and metrics.get("tool") == "get_campaign_metrics" and kind not in ("unsupported", "next_steps"):
        clicks = next((m for m in metrics.get("metrics", []) if m.get("key") == "clicks"), None)
        conversions = next((m for m in metrics.get("metrics", []) if m.get("key") == "conversions"), None)
        if not has_comparison and cvr_metric:
            found.append(
                f"Current post-click conversion-link rate {format_rate(cvr_metric.get('current'))}; no comparison baseline, so period-over-period direction cannot be asserted from the aggregate alone."
            )
        if kind in ("performance", "general"):
            if has_comparison and cvr_metric:
                found.append(f"Post-click conversion-link rate in window: {metric_line(cvr_metric)}.")
            if re.search(r"ctr|click[- ]?through", question, re.I):
                ctr = next((m for m in metrics.get("metrics", []) if m.get("key") == "ctr"), None)
                if ctr:
                    found.append(f"CTR: {metric_line(ctr)}.")
        if kind == "performance" and has_comparison and cvr_metric:
            found.append(f"Conversion-linked clicks {metric_line(conversions)}; clicks {metric_line(clicks)}.")

    if kind == "unsupported":
        explanations.append("These remain hypotheses only; current fields do not verify them.")
    else:
        explanations.append(finding.get("hypothesis") if finding else "Traffic mix, landing experience, or reporting definition may still differ.")
        explanations.append("Hypotheses only — not verified root causes.")

    build_next_steps(kind, finding, next_steps, has_comparison)

    if metrics and metrics.get("ok") and metrics.get("tool") == "get_campaign_metrics":
        append_citation_facts(found, metrics.get("citations") or [])
    if attribution and attribution.get("ok") and attribution.get("tool") == "analyze_attribution":
        append_citation_facts(found, attribution.get("citations") or [])

    ctx = {
        "metrics": metrics,
        "compare": compare,
        "trend": trend,
        "attribution": attribution,
        "anomalies": anomalies,
        "history": history,
        "finding": finding,
    }
    answer = compile_investigation_brief(
        question,
        compose_answer(question, kind, ctx, has_comparison, cvr_metric),
        conversation_history,
    )
    investigation: dict[str, Any] = {
        "found": found,
        "explanations": explanations,
        "cannotDetermine": cannot,
        "nextSteps": next_steps,
    }
    investigation = attach_presentation(
        investigation,
        {
            "question": question,
            "kind": kind,
            "results": results,
            "finding": finding,
            "hasComparison": has_comparison,
            "answerLead": answer,
        },
    )
    sections = [
        {"title": SECTION["found"], "items": found},
        {"title": SECTION["explain"], "items": explanations},
        {"title": SECTION["cannot"], "items": cannot},
        {"title": SECTION["next"], "items": next_steps},
    ]
    series = trend.get("points") if trend and trend.get("ok") and trend.get("tool") == "analyze_daily_trend" else None
    answer_kind = "investigation"
    if compare and compare.get("ok") and compare.get("tool") == "compare_campaigns":
        answer_kind = "metrics"
    if history and history.get("ok") and history.get("tool") == "retrieve_decision_history" and re.search(
        r"proposal|导出|审批|decision history", question, re.I
    ):
        answer_kind = "review"
    return {"answer": answer, "kind": answer_kind, "investigation": investigation, "sections": sections, "series": series}


def is_compile_question(question: str) -> bool:
    return bool(
        re.search(
            r"compil(?:e|ed)|summarize (?:all |the )?(?:prior |previous )?(?:investigation )?evidence|create (?:a )?(?:review )?(?:decision(?: draft)?|recommendation)|turn .{0,80}into a (?:human[- ])?review|into one (?:human[- ])?review",
            question,
            re.I,
        )
    )


def classify_question(question: str) -> str:
    q = question.lower()
    if is_compile_question(question):
        return "next_steps"
    if len(mentioned_peers(question)) > 1 and re.search(r"compare|versus|\bvs\b", q):
        return "comparison"
    if re.search(
        r"which campaign(?:s)?|campaigns (?:need|require|deserve) attention|all (?:flagged )?campaigns|account[- ]wide|portfolio[- ]wide|project[- ]wide|across (?:the )?(?:account|portfolio|project)",
        q,
    ):
        return "account_attention"
    if re.search(r"creative|素材|landing|landing page|受众|audience|budget|预算|roas|spend|fatigue|demographic|年龄", q):
        return "unsupported"
    if re.search(r"what should|verify next|next step|下一步|核验|investigate next", q):
        return "next_steps"
    if re.search(
        r"compare|versus|\bvs\b|what about|how about|同样|same pattern|is campaign [a-z0-9]+ (?:showing|the same|worse|better)|how (?:did|does) campaign|campaign [a-z0-9]+ and",
        q,
    ) or len(mentioned_peers(question)) > 1:
        return "comparison"
    if re.search(r"attribution|归因|attributed", q):
        return "attribution"
    if re.search(r"worst day|anomal|异常日|哪一天|outlier|spike", q):
        return "anomaly"
    if re.search(
        r"daily trend|daily data|across (?:the )?(?:selected )?window|across .*days|driven by .*days|sustained|concentrated|few days|few dates|日级|按日|trend behind|show me the daily",
        q,
    ):
        return "daily_trend"
    if re.search(r"decision history|proposal|导出|审批", q):
        return "decision_history"
    if re.search(r"why|what changed|change|decline|下降|cvr|ctr|conversion efficiency|collapse|re-?check|i meant|actually happened", q):
        return "performance"
    return "general"


def compose_answer(
    question: str,
    kind: str,
    ctx: dict,
    has_comparison: bool,
    cvr_metric: dict | None = None,
) -> str:
    metrics = ctx.get("metrics")
    compare = ctx.get("compare")
    trend = ctx.get("trend")
    attribution = ctx.get("attribution")
    anomalies = ctx.get("anomalies")
    history = ctx.get("history")
    finding = ctx.get("finding")

    if metrics and metrics.get("ok") and metrics.get("tool") == "get_campaign_metrics":
        name = metrics["campaignName"]
    else:
        name = (finding or {}).get("campaignName") or "This campaign"

    if re.search(r"\bctr\b|click[- ]?through rate", question, re.I) and metrics and metrics.get("ok") and metrics.get("tool") == "get_campaign_metrics":
        ctr = next((m for m in metrics.get("metrics", []) if m.get("key") == "ctr"), None)
        if ctr and ctr.get("status") == "ok":
            if ctr.get("previous") is None:
                return f"{name}'s CTR is {format_rate(ctr.get('current'))} in the selected window. No equal-length comparison window is available, so a decline or improvement is not established."
            points = None if ctr.get("pointChange") is None else abs(ctr["pointChange"])
            pc = ctr.get("pointChange") or 0
            direction = "declined" if pc < 0 else ("increased" if pc > 0 else "was unchanged")
            point_part = ""
            if points is not None:
                point_part = f", a {points:.2f} percentage-point {'decline' if pc < 0 else 'increase'}"
            return f"{name}'s CTR {direction} from {format_rate(ctr.get('previous'))} to {format_rate(ctr.get('current'))}{point_part} ({signed(ctr.get('relativePct'))} versus the prior window)."

    if kind == "account_attention" and compare and compare.get("ok") and compare.get("tool") == "compare_campaigns":
        ordered = sorted(compare.get("rows", []), key=lambda a: priority_rank(a.get("severity")))
        risks = [r for r in ordered if r.get("signalTone") == "risk"]
        opportunities = [r for r in ordered if r.get("signalTone") == "opportunity"]
        summary = "; ".join(
            f"{row['campaignName']} — {row.get('signalLabel')} {row.get('signalValue')} ({signed(row.get('signalRelativePct'))}), "
            f"{'Opportunity' if row.get('signalTone') == 'opportunity' else 'Risk'}"
            for row in ordered
        )
        if re.search(r"first human review|which campaign should|prioriti[sz]e first|review first", question, re.I) and ordered:
            first = ordered[0]
            return (
                f"{first['campaignName']} should receive the first human review. It is the highest-ranked "
                f"{first.get('severity') or 'flagged'}-severity {first.get('signalTone')} in {compare['windowLabel']}: "
                f"{first.get('signalLabel')} is {first.get('signalValue')} ({signed(first.get('signalRelativePct'))} versus the prior window). "
                "This priority is based on verified conversion-link evidence, not transformed cost, and it does not authorize a delivery change."
            )
        opp_word = "opportunity" if len(opportunities) == 1 else "opportunities"
        return (
            f"{len(ordered)} campaigns need attention in {compare['windowLabel']}: {len(risks)} risks and "
            f"{len(opportunities)} {opp_word}. Prioritize high-severity risks first while preserving positive signals. {summary}."
        )

    if kind == "unsupported":
        topic = unsupported_topic(question)
        observed = metric_movement(metrics)
        ql = question.lower()
        if re.search(r"budget|预算", ql) and re.search(r"should|increase|raise|scale|扩量|增加", ql):
            verified = f"What is verified: {observed}" if observed else "The selected window has a measured conversion-link pattern."
            return (
                f"No delivery change is supported by this snapshot alone. {verified} That observation does not prove the pattern will persist under more delivery, "
                "and the dataset has no budget, bid, or incremental-outcome fields. Validate the improvement and define an external measurement plan before considering any platform action."
            )
        extra = f" What is verified: {observed}" if observed else ""
        comparison_note = comparison_hypothesis_note(compare)
        return (
            f"{topic} could explain part of {name}'s movement, but it cannot be verified because this dataset has no "
            f"{unsupported_data_label(question)} fields.{extra}{comparison_note} Next: use the matching platform export to test that hypothesis."
        )

    if kind == "next_steps":
        if finding and finding.get("recommendation"):
            current = finding.get("raw", {}).get("cvr")
            previous = finding.get("raw", {}).get("previousCvr")
            points = abs((current - previous) * 100) if current is not None and previous is not None else None
            if current is not None and previous is not None:
                metric = (
                    f"Post-click conversion-link rate was {format_rate(current)} versus {format_rate(previous)} in the prior window"
                    + ("" if points is None else f", a {points:.2f} percentage-point {'decline' if current < previous else 'increase'}.")
                )
            else:
                metric = "The recommendation remains tied to the verified campaign evidence in this window."
            ftype = finding.get("type")
            if ftype == "scale_opportunity":
                recommendation = "validate the observed conversion-link improvement without increasing budget or delivery"
            elif ftype == "cvr_anomaly":
                recommendation = "run a manual review of the conversion-link decline before any delivery change"
            else:
                recommendation = ACTION_LABEL[finding["recommendation"]["proposal"]["actionType"]]
            return (
                f"A defensible proposal is to {recommendation}. {metric} Keep this as a human-reviewed decision: "
                "AdPilot does not execute a campaign change from this conversation."
            )
        signal = FINDING_LABEL[finding["type"]].lower() if finding else "performance"
        steps = [
            f"Check whether daily clicks and conversion-linked clicks cluster on a few days in {finding.get('windowLabel') if finding else 'this window'}.",
            (
                f"Review the formal recommendation ({STATUS_LABEL.get(finding['recommendation']['status'], finding['recommendation']['status'])}) before any external change."
                if finding and finding.get("recommendation")
                else "Draft a conservative recommendation after you confirm the daily pattern."
            ),
            "Compare peer campaigns in the same window if the issue might be portfolio-wide.",
        ]
        return f"Focus next on {signal}, not another full KPI recap. {steps[0]} {steps[1]}"

    if kind == "comparison" and compare and compare.get("ok") and compare.get("tool") == "compare_campaigns":
        row_parts = []
        for row in compare.get("rows", []):
            rel = row.get("cvrRelativePct")
            if rel is None:
                baseline = "no baseline"
            elif rel > 0:
                baseline = f"+{rel:.1f}% vs prior window"
            else:
                baseline = f"{rel:.1f}% vs prior window"
            row_parts.append(
                f"{row['campaignName']} conversion-link rate {format_rate(row.get('cvr'))} ({baseline})"
            )
        rows_joined = "; ".join(row_parts)
        comparable = [r for r in compare.get("rows", []) if r.get("cvr") is not None]
        if len(comparable) >= 2:
            diff = abs(((comparable[0].get("cvr") or 0) - (comparable[1].get("cvr") or 0)) * 100)
            higher = (comparable[0].get("cvr") or 0) >= (comparable[1].get("cvr") or 0)
            difference = (
                f"{comparable[0]['campaignName']}'s current conversion-link rate is {diff:.2f} percentage points "
                f"{'higher' if higher else 'lower'} than {comparable[1]['campaignName']}'s."
            )
        else:
            difference = "The available rows do not support a current-CVR difference calculation."
        if len(comparable) >= 2 and all(r.get("cvrRelativePct") is not None for r in comparable):
            same_dir = ((comparable[0].get("cvrRelativePct") or 0) >= 0) == ((comparable[1].get("cvrRelativePct") or 0) >= 0)
            directions = (
                "They moved in the same direction, but by different relative amounts."
                if same_dir
                else "They moved in opposite directions versus their prior windows."
            )
        else:
            directions = "Not every campaign has a prior-window baseline."
        return f"{rows_joined}. {difference} {directions} This comparison does not establish a shared root cause."

    if kind == "attribution" and attribution and attribution.get("ok") and attribution.get("tool") == "analyze_attribution":
        return f"Attribution in this window: {attribution['note']} Path-level causality is not available in the daily aggregate files."

    if (kind == "daily_trend" or kind == "anomaly") and trend and trend.get("ok") and trend.get("tool") == "analyze_daily_trend":
        return trend["note"]
    if kind == "anomaly" and anomalies and anomalies.get("ok") and anomalies.get("tool") == "detect_anomalous_days":
        return anomalies["note"]

    if kind == "decision_history" and history and history.get("ok") and history.get("tool") == "retrieve_decision_history":
        rec = next((e for e in history.get("entries", []) if e.get("kind") == "recommendation"), None)
        return f"{history['campaignName']}: recommendation {rec.get('label') if rec else 'none'}, status {rec.get('status') if rec else 'unknown'}. {history['note']}"

    if kind == "performance":
        if metrics and metrics.get("ok") and metrics.get("tool") == "get_campaign_metrics":
            clicks = next((m for m in metrics.get("metrics", []) if m.get("key") == "clicks"), None)
            conversions = next((m for m in metrics.get("metrics", []) if m.get("key") == "conversions"), None)
            if (
                clicks
                and conversions
                and cvr_metric
                and clicks.get("status") == "ok"
                and conversions.get("status") == "ok"
                and cvr_metric.get("status") == "ok"
                and clicks.get("previous") is not None
                and conversions.get("previous") is not None
                and cvr_metric.get("previous") is not None
            ):
                click_change = directional_change(clicks.get("relativePct"))
                conversion_change = directional_change(conversions.get("relativePct"))
                grew_faster = (conversions.get("relativePct") or 0) > (clicks.get("relativePct") or 0)
                if grew_faster:
                    movement = f"conversion-linked clicks grew {conversion_change}, faster than clicks"
                elif (clicks.get("relativePct") or 0) > 0 and (conversions.get("relativePct") or 0) < 0:
                    movement = f"conversion-linked clicks declined {conversion_change}"
                else:
                    verb = "declined" if (conversions.get("relativePct") or 0) < 0 else "changed"
                    movement = f"conversion-linked clicks {verb} {conversion_change}, lagging clicks"
                efficiency = "improved" if (cvr_metric.get("relativePct") or 0) >= 0 else "weaker"
                click_verb = "grew" if (clicks.get("relativePct") or 0) >= 0 else "declined"
                point_movement = ""
                if cvr_metric.get("pointChange") is not None:
                    pc = cvr_metric["pointChange"]
                    point_movement = f", {'a decline' if pc < 0 else 'an increase'} of {abs(pc):.2f} percentage points"
                premise = ""
                if asks_about_decline(question) and (cvr_metric.get("relativePct") or 0) >= 0:
                    premise = (
                        f"The premise is not supported by the selected data: {name}'s conversion-link rate did not decline; it increased. "
                    )
                priority = ""
                if re.search(r"high priority|flagged as high", question, re.I) and (finding or {}).get("severity") == "high":
                    priority = f"{name} is flagged as high priority because the verified conversion-link decline is the highest-severity risk in this window. "
                clicks_cur = f"{clicks.get('current'):,.0f}" if clicks.get("current") is not None else "0"
                conv_cur = f"{conversions.get('current'):,.0f}" if conversions.get("current") is not None else "0"
                return (
                    f"{priority}{premise}{name}'s post-click conversion-link rate was {format_rate(cvr_metric.get('current'))} versus "
                    f"{format_rate(cvr_metric.get('previous'))} in the prior window{point_movement}. "
                    f"That observation is based on {clicks_cur} clicks and {conv_cur} conversion-linked clicks. "
                    f"Clicks {click_verb} {click_change}; {movement}. "
                    f"This supports {efficiency} conversion-link efficiency for impression-date cohorts in this window. "
                    "It is not a count of unique conversion events, and it does not establish a budget, bid, creative, or audience explanation. The dataset cannot confirm a root cause. "
                    f"{finding_next_step(finding, name)}"
                )
        lead = performance_finding_lead(name, has_comparison, cvr_metric, finding)
        if re.search(r"decline has not been established", lead, re.I):
            return f"{lead} Next: inspect the daily trend or select a comparison window."
        return f"{lead} Next: review daily clicks and conversion-linked clicks for timing."

    if trend and trend.get("ok") and trend.get("tool") == "analyze_daily_trend":
        return f"{trend['note']} Insufficient evidence to determine the root cause from this alone."

    return finding_summary(finding, name)


def compile_investigation_brief(question: str, current: str, conversation_history: list[dict] | None = None) -> str:
    if not is_compile_question(question):
        return current
    prior = [item for item in (conversation_history or []) if item.get("role") == "assistant" and (item.get("content") or "").strip()]
    if not prior:
        return (
            f"This human-review recommendation is based on the evidence gathered in this turn. {current} "
            "A Decision Draft can be created from this investigation; AdPilot does not execute a delivery change."
        )
    trail = " ".join(f"Turn {index + 1}: {' '.join((item.get('content') or '').split())[:280]}" for index, item in enumerate(prior))
    return (
        f"This human-review recommendation compiles evidence from {len(prior)} prior investigation turns plus the current window metrics. "
        f"{trail} Current synthesis: {current} Create a Decision Draft for human review; AdPilot does not execute a campaign change."
    )


def comparison_hypothesis_note(compare: dict | None) -> str:
    if not compare or not compare.get("ok") or compare.get("tool") != "compare_campaigns" or len(compare.get("rows") or []) < 2:
        return ""
    names = " and ".join(row.get("campaignName") for row in compare["rows"])
    rels = [row.get("cvrRelativePct") or 0 for row in compare["rows"]]
    same = all(value < 0 for value in rels) or all(value > 0 for value in rels)
    direction = "same" if same else "opposite"
    return f" Same-window comparison of {names}: they moved in the {direction} conversion-link-rate direction. That still does not prove a shared creative cause."


def finding_next_step(finding: dict | None, name: str) -> str:
    if finding and finding.get("type") == "scale_opportunity":
        return (
            f"Recommended next step: first confirm whether {name}'s conversion-link improvement holds across days, "
            "then check creative, landing page, audience, budget, and bids in the ad platform. Do not increase delivery until that is verified outside this log."
        )
    if finding and finding.get("severity") == "high":
        window = finding.get("windowLabel") or "this window"
        return (
            f"Recommended next step: first check whether {name} had creative, landing-page, or audience changes in {window}, "
            "then inspect budget, bids, and delivery structure. Only after tracking and measurement issues are ruled out should delivery change."
        )
    if finding and finding.get("severity") == "medium":
        return (
            f"Recommended next step: verify {name}'s creative, audience, and tracking setup before changing delivery. "
            "It is lower on the review queue than a high-severity conversion-link decline in the same window."
        )
    return f"Recommended next step: verify {name}'s conversion-link evidence and platform setup before any delivery change."


def asks_about_decline(question: str) -> bool:
    return bool(
        re.search(
            r"why.*(?:declin|drop|fall)|(?:declin|drop|fall).*why|conversion efficiency decline|cvr decline|re-?check|i meant|actually happened",
            question,
            re.I,
        )
    )


def metric_movement(result: dict | None) -> str:
    if not result or not result.get("ok") or result.get("tool") != "get_campaign_metrics":
        return ""
    cvr = next((m for m in result.get("metrics", []) if m.get("key") == "cvr"), None)
    if not cvr or cvr.get("status") != "ok":
        return ""
    points = ""
    if cvr.get("pointChange") is not None:
        pc = cvr["pointChange"]
        points = f", {abs(pc):.2f} percentage points {'lower' if pc < 0 else 'higher'}"
    prev = format_rate(cvr.get("previous")) if cvr.get("previous") is not None else "no prior baseline"
    return f"post-click conversion-link rate was {format_rate(cvr.get('current'))} versus {prev}{points}."


def build_next_steps(kind: str, finding: dict | None, next_steps: list[str], has_comparison: bool) -> None:
    if kind == "next_steps":
        next_steps.append("Inspect daily click and conversion-link concentration before changing delivery.")
        next_steps.append("Compare peer campaigns in the same window if the pattern might be shared.")
        if finding and finding.get("recommendation", {}).get("status"):
            st = finding["recommendation"]["status"]
            next_steps.append(
                f"Formal recommendation is {STATUS_LABEL.get(st, st)}; discussion does not confirm or execute."
            )
        else:
            next_steps.append("Capture a human-reviewed recommendation before any external action.")
        return
    if kind == "unsupported":
        next_steps.append(
            "Import creative, audience, or spend data outside this Criteo daily aggregate if you need to test that hypothesis."
        )
        return
    if not has_comparison:
        next_steps.append("Pick a window with a comparison period, or use the daily trend to see when metrics moved.")
    else:
        next_steps.append("Check whether daily clicks and conversion-linked clicks cluster on a few days.")
    next_steps.append("Compare peer campaigns in the same window and review click volume.")
    if finding and finding.get("recommendation", {}).get("status"):
        st = finding["recommendation"]["status"]
        next_steps.append(
            f"Formal recommendation is {STATUS_LABEL.get(st, st)}; chat does not confirm or execute changes."
        )
    else:
        next_steps.append("Capture a human-reviewed recommendation before any external action.")


def append_unsupported_cannot(question: str, cannot: list[str]) -> None:
    q = question.lower()
    if re.search(r"creative|audience", q):
        cannot.append("Creative and audience dimensions are not available in this dataset.")
    if re.search(r"budget", q):
        cannot.append("Budget fields are not available; verified budget changes cannot be confirmed.")
    if re.search(r"roas", q):
        cannot.append("Revenue and ROAS fields are not available.")
    if re.search(r"delay", q):
        cannot.append("Daily aggregates lack conversion timestamps, so conversion delay cannot be assessed.")
    if re.search(r"duplicate conversion|conversion id", q):
        cannot.append(
            "Distinct conversion IDs are retained for full-dataset auditing, but they are not safely additive across daily campaign rows."
        )


def unsupported_topic(question: str) -> str:
    q = question.lower()
    if re.search(r"creative|素材|fatigue", q):
        return "Creative performance"
    if re.search(r"budget|预算", q):
        return "Budget changes"
    if re.search(r"roas", q):
        return "ROAS"
    if re.search(r"landing", q):
        return "Landing page quality"
    if re.search(r"audience|受众|age|demographic", q):
        return "Audience mix"
    if re.search(r"spend", q):
        return "Verified ad spend"
    return "That factor"


def unsupported_data_label(question: str) -> str:
    q = question.lower()
    if re.search(r"creative|素材", q):
        return "creative-level"
    if re.search(r"budget|预算|spend", q):
        return "budget or spend"
    if re.search(r"roas", q):
        return "revenue or ROAS"
    if re.search(r"landing", q):
        return "landing-page"
    if re.search(r"audience|受众", q):
        return "audience"
    return "supporting"


def metric_line(metric: dict | None) -> str:
    if not metric or metric.get("status") != "ok":
        return metric.get("reason") if metric else "Not computable"
    if metric.get("key") in ("cvr", "ctr"):
        current = format_rate(metric.get("current"))
        previous = "n/a" if metric.get("previous") is None else format_rate(metric.get("previous"))
    else:
        current = f"{float(metric.get('current') or 0):,.0f}"
        previous = "n/a" if metric.get("previous") is None else f"{float(metric.get('previous') or 0):,.0f}"
    rel = metric.get("relativePct")
    if rel is None:
        rel_text = "no relative change"
    elif rel > 0:
        rel_text = f"+{rel:.1f}% vs prior"
    else:
        rel_text = f"{rel:.1f}% vs prior"
    return f"current {current}, baseline {previous}, {rel_text}"


def signed(value: float | None) -> str:
    if value is None:
        return "no baseline"
    if value > 0:
        return f"+{value:.1f}%"
    return f"{value:.1f}%"


def directional_change(value: float | None) -> str:
    if value is None:
        return "without a baseline"
    prefix = "+" if value > 0 else ""
    return f"{prefix}{abs(value):.1f}%"


def priority_rank(value: str | None) -> int:
    if value == "high":
        return 0
    if value == "medium":
        return 1
    return 2


def title_case(value: str) -> str:
    return f"{value[0].upper()}{value[1:]}" if value else value


def finding_summary(finding: dict | None, name: str) -> str:
    if not finding:
        return (
            f"No verified signal is attached to {name} in this window. Ask for its performance, daily trend, or a comparison with another campaign."
        )
    return (
        f"{FINDING_LABEL.get(finding['type'], finding['type'])} for {name} in the selected window. "
        "Insufficient evidence to determine the root cause from aggregates alone."
    )


def mentioned_peers(question: str) -> list[str]:
    return [f"Campaign {m.group(1).upper()}" for m in re.finditer(r"campaign\s+([a-z0-9]+)", question, re.I)]


def append_citation_facts(found: list[str], citations: list[dict]) -> None:
    for cite in citations:
        chunks = [cite.get(k) for k in ("value", "baseline", "relative", "points", "absolute") if cite.get(k)]
        if not chunks:
            continue
        line = f"{cite.get('label')} {' · '.join(str(c) for c in chunks)}"
        if not any(cite.get("value") in item for item in found):
            found.append(line)

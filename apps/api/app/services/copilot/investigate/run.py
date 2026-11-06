from __future__ import annotations

import re

from app.services.analytics import get_dataset_meta
from app.services.copilot.answers import answer_question
from app.services.copilot.assist import assist_investigation
from app.services.copilot.investigate.agent import run_investigation_agent, tool_plan_for_question
from app.services.copilot.investigate.llm_config import create_investigation_budget, is_real_llm_configured
from app.services.copilot.investigate.narrate import is_compile_question, narrate_investigation
from app.services.copilot.investigate.synthesis import (
    apply_synthesis_to_investigation,
    sections_from_investigation,
    synthesize_investigation_report,
)
from app.services.copilot.service import build_product_model

FALSE_CAMPAIGN_MENTIONS = {
    "Campaign SHOW",
    "Campaign DATA",
    "Campaign PERFORMANCE",
    "Campaign RESULTS",
    "Campaign SHOULD",
    "Campaign NEED",
    "Campaign NEEDS",
    "Campaign HAS",
    "Campaign HAVE",
}


async def investigate_turn(input_data: dict) -> dict:
    pinned_window_id = input_data.get("windowId", "")
    window_id = resolve_turn_window(input_data.get("question", ""), input_data.get("history") or [], pinned_window_id)
    invalid = invalid_requested_window(window_id)
    if invalid:
        return {"answer": bare(invalid, "chat", [], None, [], [], None), "mode": "rule", "note": "Requested window is outside the imported dataset; no analysis tools were run."}
    pinned_model = None if window_id == pinned_window_id else build_product_model({"accountId": input_data.get("accountId"), "windowId": pinned_window_id})
    model = build_product_model({"accountId": input_data.get("accountId"), "windowId": window_id})
    window_switched = window_id != pinned_window_id
    bound_finding = next((f for f in model["findings"] if f["id"] == input_data.get("findingId")), None)

    if is_greeting(input_data.get("question", "")):
        msg = "Hi — I can help you inspect campaign performance, compare campaigns, or trace a change across the selected and prior windows. What would you like to look into?"
        return {"answer": bare(msg, "chat", [], None, [], [], None), "mode": "rule", "note": "Conversational reply; no campaign analysis was run."}

    requested = [m for m in mentioned(input_data.get("question", "")) if not is_false_campaign_mention(m)]
    available = {c["id"] for c in model["campaigns"]}
    missing_campaign = next((cid for cid in requested if cid not in available), None)
    if missing_campaign:
        examples = ", ".join(c["name"] for c in model["campaigns"][:4])
        return {
            "answer": bare(
                f"{missing_campaign} is not in this account. Try an available campaign such as {examples}, or ask an account-wide question.",
                "chat",
                [],
                None,
                [],
                [],
                None,
            ),
            "mode": "rule",
            "note": "Unknown campaign; no analysis tools were run.",
        }

    scope = resolve_analysis_scope(
        input_data.get("question", ""),
        input_data.get("campaignId") or (bound_finding or {}).get("campaignId"),
        model,
    )
    campaign_id = scope["primaryCampaignId"]
    finding = next((f for f in model["findings"] if f["campaignId"] == campaign_id), None) if campaign_id else None
    investigable = scope["kind"] == "account" or bool(
        campaign_id or re.search(r"campaign\s+[a-z0-9]", input_data.get("question", ""), re.I)
    )

    if not investigable:
        draft = answer_question(model, input_data.get("question", ""), input_data.get("findingId"))
        assisted = await assist_investigation(model, input_data.get("question", ""), draft, finding)
        ans = {**assisted["answer"], "series": None, "tools": [], "steps": [], "statusTrail": [], "investigation": None, "runtime": None}
        return {"answer": ans, "mode": assisted["mode"], "note": assisted["note"]}

    primary = campaign_id or (mentioned(input_data.get("question", ""))[:1] or [None])[0]
    if not primary:
        return {
            "answer": bare("Bind a campaign investigation or include a campaign name in your question.", "chat", [], None, [], [], None),
            "mode": "rule",
            "note": "No investigable campaign.",
        }

    peer_campaign_ids = [c["id"] for c in model["campaigns"] if c["id"] != primary]
    budget = create_investigation_budget()
    force_rule = input_data.get("forceRuleMode") or not is_real_llm_configured()
    try:
        budget.assert_within_wall_clock()
        agent_run = await run_investigation_agent(
            {
                "question": input_data["question"],
                "accountId": input_data["accountId"],
                "windowId": window_id,
                "campaignId": primary,
                "scope": scope["kind"],
                "scopedCampaignIds": scope["campaignIds"],
                "findingId": (finding or {}).get("id"),
                "finding": finding,
                "peerCampaignIds": peer_campaign_ids,
                "history": input_data.get("history") or [],
            },
            {"forceRuleTools": force_rule, "budget": budget},
        )
    except Exception as e:
        msg = str(e)
        ans = bare(f"Investigation stopped: {msg}.", "chat", [], None, [], [], None)
        ans["runtime"] = trace_from_agent(
            {"toolSelection": "rule", "toolSelectionErrors": [msg], "mode": "rule", "steps": [], "statusTrail": []},
            budget,
            "rule",
            "skipped",
            0,
            1,
        )
        return {"answer": ans, "mode": "rule", "note": f"Investigation budget exceeded ({msg}). Fallback to Rule-based Mode."}

    failed = next((r for r in agent_run["results"] if not r.get("ok")), None)
    if failed and len(agent_run["results"]) == 1:
        ans = bare(
            f"{failed.get('message')} No other data was used to replace this result.",
            "chat",
            [],
            None,
            agent_run["steps"],
            agent_run["statusTrail"],
            None,
        )
        fb = 1 if agent_run.get("toolSelection") == "llm_fallback" else 0
        ans["runtime"] = trace_from_agent(agent_run, budget, "rule", "skipped", 0, fb)
        return {"answer": ans, "mode": "rule", "note": "Tool query did not complete. No model rewrite was applied."}

    narrated = narrate_investigation(input_data["question"], agent_run["results"], finding, input_data.get("history") or [])
    citations = collect_citations(agent_run["results"])
    switched_lead = ""
    if window_switched:
        requested = (model.get("window") or {}).get("label") or window_id
        original = ((pinned_model or {}).get("window") or {}).get("label") or pinned_window_id
        switched_lead = f"Re-checked {requested} as requested (the conversation remains pinned to {original}). "
    answer = {
        **bare(
            f"{switched_lead}{narrated['answer']}",
            narrated["kind"],
            citations,
            narrated.get("series"),
            agent_run["steps"],
            agent_run["statusTrail"],
            narrated["investigation"],
        ),
        "sections": narrated["sections"],
    }
    tools = [r["tool"] for r in agent_run["results"] if r.get("ok")]
    tool_text = ", ".join(tools)
    window_label = (finding or {}).get("windowLabel") or (model.get("window") or {}).get("label") or window_id

    runtime = trace_from_agent(
        agent_run,
        budget,
        "rule",
        "skipped",
        0,
        1 if agent_run.get("toolSelection") == "llm_fallback" else 0,
    )
    mode = "rule" if force_rule else ("agent" if agent_run.get("mode") == "agent" else "rule")
    if force_rule:
        note = f"Rule-based investigation (LLM not used): {tool_text}. Metrics from campaign_daily.csv."
    elif agent_run.get("toolSelection") == "llm":
        note = f"Real LLM investigation: {tool_text}. Tools selected by the model; metrics from processed data."
    else:
        note = f"Fallback to Rule-based Mode (tool selection). Tools run: {tool_text}."

    if not force_rule and is_real_llm_configured() and any(r.get("ok") for r in agent_run["results"]):
        synthesis = await synthesize_investigation_report(
            {
                "question": input_data["question"],
                "history": input_data.get("history") or [],
                "campaignId": primary,
                "campaignIds": scope["campaignIds"],
                "analysisScope": scope["kind"],
                "windowLabel": window_label,
                "agentRun": agent_run,
                "citations": citations,
                "toolResults": agent_run["results"],
                "budget": budget,
            }
        )
        runtime["validationIssueCount"] = len(synthesis.get("issues") or [])
        if synthesis.get("error"):
            runtime.setdefault("synthesisErrors", []).append(synthesis["error"])
        if synthesis.get("status") == "verified" and synthesis.get("draft"):
            inv = apply_synthesis_to_investigation(
                answer.get("investigation") or {"found": [], "explanations": [], "cannotDetermine": [], "nextSteps": []},
                synthesis,
            )
            answer.update(
                {
                    "answer": synthesis["draft"]["summary"],
                    "investigation": inv,
                    "sections": sections_from_investigation(inv),
                    "kind": "investigation",
                }
            )
            runtime["investigationMode"] = "llm"
            runtime["reportSynthesis"] = "llm_verified"
            mode = "llm"
            note = f"Real LLM investigation with evidence validation. Tools: {tool_text}."
        elif synthesis.get("status") == "partial" and synthesis.get("draft"):
            inv = apply_synthesis_to_investigation(
                answer.get("investigation") or {"found": [], "explanations": [], "cannotDetermine": [], "nextSteps": []},
                synthesis,
            )
            answer.update(
                {
                    "answer": f"{synthesis['draft']['summary']} (Partial LLM report — some facts did not pass validation.)",
                    "investigation": inv,
                    "sections": sections_from_investigation(inv),
                }
            )
            runtime["investigationMode"] = "llm_partial"
            runtime["reportSynthesis"] = "llm_partial"
            mode = "llm_partial"
            note = f"Partial LLM investigation. Validation issues: {len(synthesis.get('issues') or [])}. Rule-based facts retained where needed."
        else:
            runtime["reportSynthesis"] = "rule_template"
            runtime.setdefault("synthesisErrors", []).append("LLM report synthesis failed or was rejected.")
            runtime["fallbackCount"] = runtime.get("fallbackCount", 0) + 1
            runtime["fallbackLabel"] = runtime.get("fallbackLabel") or "Fallback to Rule-based Mode (report synthesis)"
            note = f"{note} Fallback to Rule-based Mode (report synthesis)."
    else:
        runtime["reportSynthesis"] = "rule_template"

    runtime["llmCallCount"] = budget.llm_calls
    runtime["elapsedMs"] = budget.elapsed_ms()

    use_assist = not force_rule and mode == "rule" and answer.get("kind") == "investigation"
    if use_assist:
        assisted = await assist_investigation(model, input_data["question"], answer, finding)
    else:
        assisted_mode = mode if mode in ("llm", "llm_partial") else mode
        assisted = {"answer": answer, "mode": assisted_mode, "note": ""}

    if assisted.get("mode") == "ai" and mode == "rule":
        mode = "ai"
        note = assisted.get("note") or note

    compile_ready = is_compile_question(input_data.get("question", ""))
    final_answer = {
        **assisted["answer"],
        "series": answer.get("series"),
        "tools": tools,
        "steps": agent_run["steps"],
        "statusTrail": agent_run["statusTrail"],
        "investigation": answer.get("investigation"),
        "runtime": runtime,
        "reviewReady": compile_ready or assisted["answer"].get("reviewReady"),
        "kind": "review" if compile_ready else assisted["answer"].get("kind"),
    }
    final_note = assisted.get("note") if mode == "ai" and assisted.get("note") else note
    return {"answer": final_answer, "mode": mode, "note": final_note}


def resolve_turn_window(question: str, history: list[dict], fallback: str) -> str:
    from_question = parse_window_mention(question)
    if from_question:
        return from_question
    for turn in reversed(history or []):
        if turn.get("role") != "user":
            continue
        found = parse_window_mention(turn.get("content") or "")
        if found:
            return found
    return fallback


def parse_window_mention(text: str) -> str | None:
    compact = re.sub(r"\s+", " ", text.lower())
    match = re.search(r"\bd\s*(\d+)\s*[–\-]\s*d?\s*(\d+)\b", compact)
    if match:
        return f"d{match.group(1)}-d{match.group(2)}"
    if re.search(r"\bearlier (analysis )?window\b|\bprevious 7[- ]day\b|\bprior 7[- ]day\b", compact):
        return "d18-d24"
    if re.search(r"\b(?:latest|recent) 7[- ]day\b|\brecent[_ ]7d\b", compact) and "window" in compact:
        return "recent_7d"
    return None


def invalid_requested_window(window_id: str) -> str | None:
    m = re.match(r"^d(\d+)-d(\d+)$", window_id)
    if not m:
        return None
    start, end = int(m.group(1)), int(m.group(2))
    max_day = get_dataset_meta().maxDay
    if start >= 1 and end >= start and end <= max_day:
        return None
    return (
        f"Requested window D{start}–D{end} is outside the imported relative-day coverage D1–D{max_day}. "
        f"Choose a window within D1–D{max_day}; no fallback window was analyzed."
    )


def is_greeting(question: str) -> bool:
    return bool(
        re.match(
            r"^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|adpilot))?[.!?\s]*$",
            question.strip(),
            re.I,
        )
    )


def resolve_analysis_scope(question: str, bound_campaign_id: str | None, model: dict) -> dict:
    q = question.lower()
    all_ids = [c["id"] for c in model["campaigns"]]
    flagged = [f["campaignId"] for f in model["findings"]]
    mentions = [m for m in mentioned(question) if m in all_ids]
    account_wide = bool(
        re.search(
            r"which campaign(?:s)?|campaigns (?:need|require|deserve) attention|all (?:flagged )?campaigns|across (?:the )?(?:account|portfolio|project)|account[- ]wide|portfolio[- ]wide|project[- ]wide|overall (?:account|project)",
            q,
        )
    )
    comparison_intent = bool(re.search(r"compare|versus|\bvs\b|other campaign|same pattern|what about|how about|is campaign [a-z0-9]+ (?:showing|the same|worse|better)|how (?:did|does) campaign|worse|better|相比|同样", q))
    if len(mentions) > 1 and comparison_intent:
        return {"kind": "comparison", "primaryCampaignId": mentions[0], "campaignIds": list(dict.fromkeys(mentions))}
    if account_wide:
        ids = flagged if flagged else all_ids
        return {"kind": "account", "primaryCampaignId": ids[0] if ids else bound_campaign_id, "campaignIds": ids}
    if len(mentions) > 1 or (len(mentions) == 1 and bound_campaign_id and mentions[0] != bound_campaign_id and comparison_intent):
        ids = list(dict.fromkeys([*( [bound_campaign_id] if bound_campaign_id else []), *mentions]))
        return {"kind": "comparison", "primaryCampaignId": mentions[0] or bound_campaign_id, "campaignIds": ids}
    if len(mentions) == 1:
        return {"kind": "campaign", "primaryCampaignId": mentions[0], "campaignIds": mentions}
    if bound_campaign_id:
        return {"kind": "campaign", "primaryCampaignId": bound_campaign_id, "campaignIds": [bound_campaign_id]}
    return {"kind": "campaign", "primaryCampaignId": None, "campaignIds": []}


def collect_citations(results: list) -> list:
    cites = []
    for result in results:
        if not result.get("ok"):
            continue
        if isinstance(result.get("citations"), list):
            cites.extend(result["citations"])
            if result.get("tool") == "get_campaign_metrics":
                cites.extend(
                    c
                    for c in result["citations"]
                    if c.get("metric") in ("clicks", "conversions", "cvr", "ctr")
                )
    seen = set()
    out = []
    for c in cites:
        cid = c.get("id")
        if cid in seen:
            continue
        seen.add(cid)
        out.append(c)
    return out


def bare(answer, kind, citations, series, steps, status_trail, investigation) -> dict:
    evidence = []
    for item in citations or []:
        source = f"{item.get('source')} · {item.get('windowLabel')}"
        if item.get("compareLabel"):
            source += f" · {item['compareLabel']}"
        source += f" · Current {item.get('value')} · Prior {item.get('baseline') or 'unavailable'}"
        if item.get("absolute"):
            source += f" · Absolute {item['absolute']}"
        if item.get("points"):
            source += f" · {item['points']}"
        evidence.append(
            {
                "label": item.get("label"),
                "value": item.get("value"),
                "source": source,
                "id": item.get("id"),
                "baseline": item.get("baseline"),
                "absolute": item.get("absolute"),
                "relative": item.get("relative"),
                "points": item.get("points"),
                "windowLabel": item.get("windowLabel"),
                "compareLabel": item.get("compareLabel"),
                "metric": item.get("metric"),
            }
        )
    return {
        "answer": answer,
        "kind": kind,
        "evidence": evidence,
        "uncertainty": "Figures are deterministic calculations from the processed snapshot. Budget, bid, creative, landing-page, and verified spend fields are unavailable.",
        "revision": None,
        "sections": [],
        "reviewReady": False,
        "series": series,
        "tools": [],
        "steps": steps,
        "statusTrail": status_trail,
        "investigation": investigation,
        "runtime": None,
    }


def mentioned(question: str) -> list[str]:
    return [f"Campaign {m.group(1).upper()}" for m in re.finditer(r"campaign\s+([a-z0-9]+)", question, re.I)]


def is_false_campaign_mention(cid: str) -> bool:
    return cid in FALSE_CAMPAIGN_MENTIONS


def trace_from_agent(agent_run, budget, investigation_mode, report_synthesis, validation_issue_count, fallback_count) -> dict:
    tool_sel = agent_run.get("toolSelection", "rule")
    return {
        "investigationMode": investigation_mode,
        "toolSelection": tool_sel,
        "reportSynthesis": report_synthesis,
        "toolSelectionErrors": agent_run.get("toolSelectionErrors") or [],
        "synthesisErrors": [],
        "validationIssueCount": validation_issue_count,
        "fallbackLabel": "Fallback to Rule-based Mode (tool selection)" if tool_sel == "llm_fallback" else None,
        "llmCallCount": budget.llm_calls,
        "fallbackCount": fallback_count,
        "elapsedMs": budget.elapsed_ms(),
    }


def tool_plan_for(question: str, model: dict, finding_id: str | None = None) -> list[str]:
    finding = next((f for f in model["findings"] if f["id"] == finding_id), None)
    scope = resolve_analysis_scope(question, (finding or {}).get("campaignId"), model)
    campaign_id = scope["primaryCampaignId"] or "Campaign R"
    scoped = scope["campaignIds"] if scope["campaignIds"] else [campaign_id]
    plan = tool_plan_for_question(
        question,
        {
            "question": question,
            "accountId": model["account"]["id"],
            "windowId": (finding or {}).get("windowId") or (model.get("window") or {}).get("id") or "recent_7d",
            "campaignId": campaign_id,
            "scope": scope["kind"],
            "scopedCampaignIds": scoped,
            "findingId": (finding or {}).get("id"),
            "finding": finding,
            "peerCampaignIds": [c["id"] for c in model["campaigns"] if c["id"] != campaign_id],
            "history": [],
        },
    )
    return [item["tool"] for item in plan]

import json

from app.services.llm.provider import get_llm_provider_from_env
from app.services.copilot.investigate.agent import with_timeout
from app.services.copilot.investigate.validate_report import validate_investigation_draft

MAX_ATTEMPTS = 2

SYSTEM = """You are an advertising analytics investigator. Output JSON only.
Rules:
- observedFacts must only use numbers and metrics present in toolResults and citations.
- Each observedFact needs tier: "numeric" (raw counts/rates from tools), "computed" (derived comparison such as window change), or "context" (scope/window labels only).
- Mark observedFacts verified=true only for numeric/computed tiers when you cite valid evidenceIds. context tier must use verified=false.
- Never mark a full root-cause diagnosis as verified.
- hypotheses must all have unverified=true and must not state root causes as facts.
- Do not claim budget, real spend, ROAS, creative fatigue, audience demographics, landing page performance, or conversion delay.
- proposedActions are review steps only, not executed changes.
Schema:
{
  "summary": "short lead paragraph",
  "observedFacts": [{"text":"...","verified":true,"tier":"numeric","evidenceIds":["metric:..."]}],
  "hypotheses": [{"text":"...","unverified":true}],
  "supportingEvidenceIds": ["metric:..."],
  "missingEvidence": ["..."],
  "recommendedChecks": ["..."],
  "proposedActions": ["..."],
  "limitations": ["..."]
}"""


async def synthesize_investigation_report(input_data: dict) -> dict:
    provider = get_llm_provider_from_env()
    campaign_ids = input_data.get("campaignIds") or [input_data["campaignId"]]
    payload = {
        "question": input_data["question"],
        "recentConversation": (input_data.get("history") or [])[-6:],
        "campaignId": input_data["campaignId"],
        "campaignIds": campaign_ids,
        "analysisScope": input_data.get("analysisScope") or "campaign",
        "windowLabel": input_data["windowLabel"],
        "toolSteps": (input_data.get("agentRun") or {}).get("steps"),
        "toolResults": summarize_results(input_data.get("toolResults") or []),
        "citations": input_data.get("citations"),
    }
    last_issues, last_error = [], None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            if input_data.get("budget"):
                input_data["budget"].assert_can_call_llm()
            raw = await with_timeout(
                provider.generate_structured(SYSTEM, json.dumps({**payload, "priorIssues": last_issues}))
            )
            if input_data.get("budget"):
                input_data["budget"].record_llm_call()
            issues = validate_investigation_draft(raw, input_data["citations"], campaign_ids)
            if not issues and (raw.get("summary") or "").strip() and (raw.get("observedFacts") or []):
                return {"status": "verified", "draft": raw, "issues": [], "attempts": attempt, "error": None}
            last_issues = issues
            if attempt == MAX_ATTEMPTS and (raw.get("summary") or "").strip():
                return {"status": "partial", "draft": raw, "issues": issues, "attempts": attempt, "error": None}
        except Exception as e:
            last_error = str(e)
    return {"status": "failed", "draft": None, "issues": last_issues, "attempts": MAX_ATTEMPTS, "error": last_error}


def apply_synthesis_to_investigation(rule_payload: dict, outcome: dict) -> dict:
    if not outcome.get("draft"):
        return {**rule_payload, "synthesisStatus": "failed" if outcome.get("status") == "failed" else "rule"}
    draft = outcome["draft"]
    found = []
    for item in draft.get("observedFacts") or []:
        if not item.get("verified"):
            found.append(f"[Unverified] {item.get('text')}")
        elif item.get("tier") == "computed":
            found.append(f"[Verified computed] {item.get('text')}")
        elif item.get("tier") == "context":
            found.append(f"[Context] {item.get('text')}")
        else:
            found.append(f"[Verified numeric] {item.get('text')}")
    explanations = [f"(Unverified) {h.get('text')}" for h in draft.get("hypotheses") or []]
    cannot = list(
        dict.fromkeys(
            [
                *(rule_payload.get("cannotDetermine") or []),
                *(draft.get("limitations") or []),
                *[f"Missing evidence: {m}" for m in draft.get("missingEvidence") or []],
            ]
        )
    )
    next_steps = [*draft.get("recommendedChecks", []), *draft.get("proposedActions", [])]
    return {
        **rule_payload,
        "found": found if found else rule_payload.get("found"),
        "explanations": explanations if explanations else rule_payload.get("explanations"),
        "cannotDetermine": cannot,
        "nextSteps": next_steps if next_steps else rule_payload.get("nextSteps"),
        "structured": {
            "observedFacts": draft.get("observedFacts"),
            "hypotheses": draft.get("hypotheses"),
            "supportingEvidenceIds": draft.get("supportingEvidenceIds"),
            "missingEvidence": draft.get("missingEvidence"),
            "recommendedChecks": draft.get("recommendedChecks"),
            "proposedActions": draft.get("proposedActions"),
            "limitations": draft.get("limitations"),
        },
        "synthesisStatus": outcome.get("status"),
    }


def sections_from_investigation(payload: dict) -> list[dict]:
    return [
        {"title": "Observed Facts", "items": payload.get("found", [])},
        {"title": "Hypotheses (Unverified)", "items": payload.get("explanations", [])},
        {"title": "Limitations & Missing Evidence", "items": payload.get("cannotDetermine", [])},
        {"title": "Recommended Checks & Actions", "items": payload.get("nextSteps", [])},
    ]


def summarize_results(results: list) -> list:
    out = []
    for item in results:
        if not item.get("ok"):
            out.append({"tool": item.get("tool"), "ok": False, "message": item.get("message")})
            continue
        tool = item.get("tool")
        if tool == "get_campaign_metrics":
            out.append(
                {
                    "tool": tool,
                    "ok": True,
                    "campaign": item.get("campaignName"),
                    "window": item.get("windowLabel"),
                    "metrics": [
                        {"key": m.get("key"), "current": m.get("current"), "previous": m.get("previous"), "status": m.get("status")}
                        for m in item.get("metrics", [])
                    ],
                }
            )
        elif tool == "analyze_daily_trend":
            out.append({"tool": tool, "ok": True, "note": item.get("note"), "points": len(item.get("points") or [])})
        elif tool == "compare_campaigns":
            out.append(
                {
                    "tool": tool,
                    "ok": True,
                    "rows": [
                        {
                            "id": r.get("campaignId"),
                            "clicks": r.get("clicks"),
                            "conversions": r.get("conversions"),
                            "cvr": r.get("cvr"),
                            "signalMetric": r.get("signalMetric"),
                            "signalValue": r.get("signalValue"),
                            "signalRelativePct": r.get("signalRelativePct"),
                            "signalTone": r.get("signalTone"),
                            "severity": r.get("severity"),
                        }
                        for r in item.get("rows", [])
                    ],
                }
            )
        elif tool == "analyze_attribution":
            out.append({"tool": tool, "ok": True, "note": item.get("note"), "share": item.get("attributionShare")})
        elif tool == "detect_anomalous_days":
            out.append(
                {
                    "tool": tool,
                    "ok": True,
                    "note": item.get("note"),
                    "flagged": len([d for d in item.get("days", []) if d.get("notable")]),
                }
            )
        elif tool == "retrieve_decision_history":
            out.append({"tool": tool, "ok": True, "entries": len(item.get("entries") or []), "note": item.get("note")})
        else:
            out.append({"tool": "get_campaign_metrics", "ok": True})
    return out

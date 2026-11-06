from app.services.copilot.investigate.llm_config import is_real_llm_configured
from app.services.llm.provider import get_llm_provider_from_env
from app.services.copilot.investigate.agent import with_timeout

ALLOWED = __import__("re").compile(r"cannot|can't|not available|unverified|hypothesis|not confirm|no budget|no roas|not in this dataset", __import__("re").I)


async def assist_investigation(model: dict, question: str, draft: dict, finding: dict | None) -> dict:
    if not finding or draft.get("kind") != "investigation":
        return {"answer": draft, "mode": "rule", "note": "Rule-based analysis (no model enrichment)."}
    if not is_real_llm_configured():
        return {"answer": draft, "mode": "rule", "note": "Rule-based analysis (no LLM configured)."}
    try:
        provider = get_llm_provider_from_env()
        facts = next((s.get("items") for s in draft.get("sections", []) if s.get("title") == "What We Found"), []) or []
        result = await with_timeout(
            provider.generate_structured(
                'Add only unverified hypotheses and verification steps in English. Output JSON {"hypotheses":["..."],"checks":["..."]}.',
                __import__("json").dumps({"question": question, "campaign": finding["campaignName"], "facts": facts, "missing": model.get("missing")}),
            )
        )
        accepted = accept_model_investigation(result, number_set(draft))
        if not accepted:
            return {"answer": draft, "mode": "rule", "note": "Model output failed validation; rule-based analysis retained."}
        sections = []
        for section in draft.get("sections", []):
            if section.get("title") == "Possible Explanations":
                sections.append({**section, "items": accepted["hypotheses"]})
            elif section.get("title") == "Recommended Next Steps":
                sections.append({**section, "items": accepted["checks"]})
            else:
                sections.append(section)
        return {"answer": {**draft, "sections": sections}, "mode": "ai", "note": "Metrics from deterministic tools; hypotheses enriched by model."}
    except Exception:
        return {"answer": draft, "mode": "rule", "note": "Model enrichment unavailable; rule-based analysis retained."}


def accept_model_investigation(raw: dict, allowed_numbers: set) -> dict | None:
    hypotheses = clean_list(raw.get("hypotheses"))
    checks = clean_list(raw.get("checks"))
    if len(hypotheses) < 1 or len(checks) < 1:
        return None
    lines = hypotheses + checks
    if any(not ALLOWED.search(line) for line in lines):
        return None
    nums = __import__("re").findall(r"\d+(?:\.\d+)?", " ".join(lines))
    if any(n not in allowed_numbers for n in nums):
        return None
    return {"hypotheses": hypotheses[:3], "checks": checks[:3]}


def clean_list(value):
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if isinstance(item, str) and 8 <= len(str(item).strip()) <= 180]


def number_set(draft: dict) -> set:
    text = " ".join([draft.get("answer", ""), *[i for s in draft.get("sections", []) for i in s.get("items", [])]])
    return set(__import__("re").findall(r"\d+(?:\.\d+)?", text))

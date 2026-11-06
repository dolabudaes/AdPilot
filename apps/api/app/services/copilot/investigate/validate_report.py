import json
import re

from app.services.eval.claims import scan_unsupported_claims

CAUSAL = re.compile(r"caused by|root cause|due to|because of|because the|归因于|根因|导致|由于|原因是|confirmed cause", re.I)


def allowed_citation_ids(citations: list) -> set:
    return {c["id"] for c in citations}


def allowed_number_tokens(citations: list, extra_text: str = "") -> set:
    tokens = set()
    for cite in citations:
        for field in ("value", "baseline", "absolute", "relative", "points"):
            val = cite.get(field)
            if val:
                tokens.update(re.findall(r"\d+(?:\.\d+)?", str(val)))
    tokens.update(re.findall(r"\d+(?:\.\d+)?", extra_text))
    return tokens


def validate_investigation_draft(draft: dict, citations: list, campaign_id) -> list[dict]:
    issues = []
    ids = allowed_citation_ids(citations)
    numbers = allowed_number_tokens(citations, "")
    blob = json.dumps(draft)
    allowed_campaigns = [c.lower() for c in (campaign_id if isinstance(campaign_id, list) else [campaign_id])]
    if scan_unsupported_claims(blob):
        issues.append({"id": "unsupported-claim", "detail": "Report contains prohibited unsupported claims."})
    for fact in draft.get("observedFacts") or []:
        if not (fact.get("text") or "").strip():
            issues.append({"id": "empty-fact", "detail": "Observed fact text is empty."})
        tier = fact.get("tier") or "numeric"
        if tier == "context" and fact.get("verified"):
            issues.append({"id": "context-marked-verified", "detail": "Context statements cannot be marked verified."})
        if fact.get("verified") and CAUSAL.search(fact.get("text", "")):
            issues.append({"id": "verified-causal-overreach", "detail": "Verified facts cannot state root causes."})
        if fact.get("verified"):
            eids = fact.get("evidenceIds") or []
            if not eids:
                issues.append({"id": "verified-without-evidence", "detail": "Verified fact missing evidence IDs."})
            for eid in eids:
                if eid not in ids:
                    issues.append({"id": "unknown-evidence-id", "detail": f"Unknown evidence id {eid}"})
            for num in re.findall(r"\d+(?:\.\d+)?", fact.get("text", "")):
                if num not in numbers:
                    issues.append({"id": "ungrounded-number", "detail": f"Number {num} not in tool citations"})
    for hyp in draft.get("hypotheses") or []:
        if hyp.get("unverified") is not True:
            issues.append({"id": "hypothesis-not-marked", "detail": "Hypothesis must be marked unverified."})
    return issues

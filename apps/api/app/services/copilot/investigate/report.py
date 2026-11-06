import html
import re
import uuid
from datetime import datetime, timezone

from app.db import get_db
from app.services.copilot.labels import FINDING_LABEL, STATUS_LABEL
from app.services.copilot.service import build_product_model

METRIC_LABELS = {
    "曝光": "Impressions",
    "点击": "Clicks",
    "点击率": "CTR",
    "转化": "Conversion-linked clicks",
    "转化关联点击": "Conversion-linked clicks",
    "点击后转化率": "Post-click conversion-link rate",
    "点击后转化关联率": "Post-click conversion-link rate",
    "归因转化": "Attributed conversion links",
    "成本指数": "Cost index",
    "成本指数总值": "Cost index total",
    "单次点击成本指数": "Average cost index per click",
    "归因占比": "Attribution-link share",
}


def save_investigation_report(conversation: dict, messages: list[dict]) -> dict:
    model = build_product_model({"accountId": conversation["accountId"], "windowId": conversation["windowId"]})
    finding = (
        next((f for f in model["findings"] if f["id"] == conversation["findingId"]), None)
        if conversation.get("findingId")
        else None
    )
    title = (
        f"{finding['campaignName']} — {FINDING_LABEL.get(finding['type'], finding['type'])} Investigation Report"
        if finding
        else "AdPilot Investigation Report"
    )
    report_html = build_report_html(conversation, messages, title)
    rid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    get_db().execute(
        """INSERT INTO investigation_reports (id, conversation_id, account_id, campaign_id, finding_id, window_id, snapshot_at, title, html, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            rid,
            conversation["id"],
            conversation["accountId"],
            conversation.get("campaignId"),
            conversation.get("findingId"),
            conversation["windowId"],
            conversation.get("snapshotAt"),
            title,
            report_html,
            now,
        ),
    )
    get_db().commit()
    return {"id": rid, "title": title, "html": report_html, "createdAt": now}


def build_report_html(conversation: dict, messages: list[dict], finding_title: str | None) -> str:
    assistant = [m for m in messages if m["role"] == "assistant" and m["status"] == "completed"]
    last = assistant[-1] if assistant else None
    investigation = last.get("investigation") if last else None
    model = build_product_model({"accountId": conversation["accountId"], "windowId": conversation["windowId"]})
    finding = (
        next((f for f in model["findings"] if f["id"] == conversation["findingId"]), None)
        if conversation.get("findingId")
        else None
    )
    review_status = (
        STATUS_LABEL.get(finding["recommendation"]["status"], finding["recommendation"]["status"])
        if finding and finding.get("recommendation")
        else "No linked recommendation"
    )
    decision_id = finding.get("recommendation", {}).get("decisionId") if finding and finding.get("recommendation") else None
    evidence_ids = [item["id"] for item in (last.get("evidence") or []) if item.get("id")]
    structured_ids = (investigation or {}).get("structured", {}).get("supportingEvidenceIds") or []

    compare_part = f" · {conversation['compareLabel']}" if conversation.get("compareLabel") else ""
    sections = [
        {
            "title": "Executive Summary",
            "body": english_report_text(last.get("content") if last else None, "The investigation has not produced a complete response yet."),
        },
        {
            "title": "Campaign Performance Overview",
            "body": (
                f"{conversation.get('campaignId') or 'Account'} · {conversation['windowId']}{compare_part} · "
                f"Historical snapshot {conversation.get('snapshotAt') or 'unavailable'}. This is not live platform data."
            ),
        },
        {
            "title": "Key Findings",
            "items": english_items(
                (investigation or {}).get("found"),
                [
                    "Performance changed materially in the selected analysis window.",
                    "The available metrics confirm the change but do not establish a root cause.",
                ],
            ),
        },
        {
            "title": "Supporting Metrics",
            "items": [
                f"{english_metric(item['label'])}: {item['value']}{f' · {item['relative']}' if item.get('relative') else ''}"
                for item in (last.get("evidence") or [])
            ],
        },
        {
            "title": "Data Limitations",
            "items": [
                "Budget, bid, revenue, ROAS, creative, audience, landing-page, and verified spend fields are unavailable."
            ],
        },
        {
            "title": "Recommended Next Steps",
            "items": english_items(
                (investigation or {}).get("nextSteps"),
                [
                    "Review the campaign context and daily trend before changing delivery.",
                    "Any formal action still requires human review.",
                ],
            ),
        },
        {
            "title": "Human Review Status",
            "body": f"{review_status}. This report does not confirm, execute, or modify a formal decision.",
        },
        {
            "title": "Linked Records",
            "body": (
                f"Finding {conversation.get('findingId') or 'none'} · Campaign {conversation.get('campaignId') or 'none'} · "
                f"Window {conversation['windowId']} · Snapshot {conversation.get('snapshotAt') or 'unavailable'} · "
                f"Decision {decision_id or 'none'} · Evidence snapshot {len(evidence_ids)} ids · "
                f"Structured evidence {len(structured_ids)} ids."
            ),
        },
    ]

    created = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    body_html = []
    for section in sections:
        if section.get("body"):
            body_html.append(f"<h2>{escape_html(section['title'])}</h2><p>{escape_html(section['body'])}</p>")
        else:
            items = section.get("items") or []
            lis = "".join(f"<li>{escape_html(item)}</li>" for item in items)
            body_html.append(f"<h2>{escape_html(section['title'])}</h2><ul>{lis}</ul>")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>{escape_html(conversation['title'])} — AdPilot Report</title>
  <style>
    body {{ font-family: "Segoe UI", system-ui, sans-serif; color: #0f172a; max-width: 880px; margin: 2rem auto; line-height: 1.55; }}
    h1 {{ font-size: 1.6rem; margin-bottom: 0.25rem; }}
    h2 {{ font-size: 1.1rem; margin-top: 1.75rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.35rem; }}
    .meta {{ color: #64748b; font-size: 0.92rem; }}
    ul {{ padding-left: 1.2rem; }}
    .badge {{ display: inline-block; background: #f1f5f9; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.85rem; }}
    @media print {{ body {{ margin: 0.5in; }} }}
  </style>
</head>
<body>
  <p class="badge">Imported Demo Dataset · Investigation Report</p>
  <h1>{escape_html(finding_title or conversation['title'])}</h1>
  <p class="meta">AdPilot · {escape_html(conversation['accountId'])} · Conversation {escape_html(conversation['id'])}</p>
  {''.join(body_html)}
  <p class="meta">Created {created} · This report does not represent verified financial impact or a confirmed root cause.</p>
</body>
</html>"""


def escape_html(value: str) -> str:
    return html.escape(value, quote=True)


def has_chinese(value: str) -> bool:
    return bool(re.search(r"[\u3400-\u9fff]", value))


def english_report_text(value: str | None, fallback: str) -> str:
    return value if value and not has_chinese(value) else fallback


def english_items(items: list[str] | None, fallback: list[str]) -> list[str]:
    if items and len(items) and all(not has_chinese(item) for item in items):
        return items
    return fallback


def english_metric(value: str) -> str:
    if value in METRIC_LABELS:
        return METRIC_LABELS[value]
    return "Supporting metric" if has_chinese(value) else value


def get_investigation_report(report_id: str) -> dict | None:
    row = get_db().execute("SELECT * FROM investigation_reports WHERE id = ?", (report_id,)).fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "conversationId": row["conversation_id"],
        "accountId": row["account_id"],
        "campaignId": row["campaign_id"],
        "findingId": row["finding_id"],
        "windowId": row["window_id"],
        "snapshotAt": row["snapshot_at"],
        "title": row["title"],
        "html": row["html"],
        "createdAt": row["created_at"],
    }


def list_reports_for_conversation(conversation_id: str) -> list[dict]:
    rows = get_db().execute(
        "SELECT id, title, created_at FROM investigation_reports WHERE conversation_id = ? ORDER BY created_at DESC",
        (conversation_id,),
    ).fetchall()
    return [{"id": r["id"], "title": r["title"], "createdAt": r["created_at"]} for r in rows]

import json
import uuid
from datetime import datetime, timezone

from app.db import get_db
from app.errors import CopilotError
from app.services.copilot.conversations import get_conversation_for_actor
from app.services.copilot.store import recommendation_id_for
from app.services.copilot.recommend import propose
from app.services.copilot.service import build_product_model, parse_finding_id, edit_finding
from app.services.json_util import parse_json


def list_strategy_versions(finding_id: str) -> list[dict]:
    rec_id = recommendation_id_for(finding_id)
    rows = get_db().execute(
        "SELECT * FROM strategy_versions WHERE finding_id = ? AND recommendation_id = ? ORDER BY version_number DESC",
        (finding_id, rec_id),
    ).fetchall()
    return [map_version(dict(r)) for r in rows]


def save_strategy_version(input_data: dict) -> dict:
    parsed = parse_finding_id(input_data["findingId"])
    if not parsed:
        raise CopilotError("The finding identifier is invalid.")
    model = build_product_model({"accountId": parsed["accountId"], "windowId": parsed["windowId"]})
    finding = next((f for f in model["findings"] if f["id"] == input_data["findingId"]), None)
    if not finding:
        raise CopilotError("The finding is not available in this analysis window.", 404)
    reason = (input_data.get("reason") or "").strip()
    if len(reason) < 8:
        raise CopilotError("Add a clear rationale before saving this version.")
    if input_data.get("conversationId"):
        conv = get_conversation_for_actor(input_data["conversationId"], input_data["actorId"])
        if conv["accountId"] != finding["accountId"] or conv["findingId"] != finding["id"]:
            raise CopilotError("The conversation does not belong to this investigation.", 409)
    draft = {k: v for k, v in finding.items() if k not in ("recommendation", "stale")}
    proposal = propose(draft, {"actionType": input_data["actionType"], "reason": reason})
    if not proposal:
        raise CopilotError("This finding cannot produce a strategy candidate.")
    rec = finding.get("recommendation")
    if rec and rec.get("status") not in ("draft", "rejected", "expired"):
        pass
    else:
        edit_finding(finding["id"], input_data["actorId"], input_data["actionType"], reason)
    rec_id = (rec or {}).get("id") or recommendation_id_for(finding["id"])
    last = get_db().execute(
        "SELECT id, version_number FROM strategy_versions WHERE finding_id = ? AND recommendation_id = ? ORDER BY version_number DESC LIMIT 1",
        (finding["id"], rec_id),
    ).fetchone()
    latest = get_db().execute("SELECT MAX(version_number) AS version_number FROM strategy_versions WHERE finding_id = ?", (finding["id"],)).fetchone()
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    vid = str(uuid.uuid4())
    get_db().execute(
        """INSERT INTO strategy_versions (
          id, recommendation_id, finding_id, account_id, window_id, campaign_id, version_number,
          parent_version_id, conversation_id, message_id, proposal_json, source, actor_id, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            vid,
            rec_id,
            finding["id"],
            finding["accountId"],
            finding["windowId"],
            finding["campaignId"],
            (latest["version_number"] or 0) + 1,
            last["id"] if last else None,
            input_data.get("conversationId"),
            input_data.get("messageId"),
            json.dumps(proposal),
            input_data.get("source") or "human",
            input_data["actorId"],
            now,
        ),
    )
    get_db().commit()
    row = get_db().execute("SELECT * FROM strategy_versions WHERE id = ?", (vid,)).fetchone()
    return map_version(dict(row))


def map_version(row: dict) -> dict:
    return {
        "id": row["id"],
        "recommendationId": row["recommendation_id"],
        "findingId": row["finding_id"],
        "accountId": row["account_id"],
        "windowId": row["window_id"],
        "campaignId": row["campaign_id"],
        "versionNumber": row["version_number"],
        "parentVersionId": row["parent_version_id"],
        "conversationId": row["conversation_id"],
        "messageId": row["message_id"],
        "proposal": parse_json(row["proposal_json"], {}),
        "source": "ai" if row["source"] == "ai" else "human",
        "actorId": row["actor_id"],
        "createdAt": row["created_at"],
    }

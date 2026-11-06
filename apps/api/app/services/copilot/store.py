from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from app.db import get_db, next_id
from app.errors import CopilotError
from app.services.analytics import get_dataset_meta
from app.services.copilot.english_copy import english_proposal_text, english_stored_proposal, english_window_label, has_chinese
from app.services.copilot.windows import resolve_window
from app.services.copilot.labels import ACTION_LABEL
from app.services.copilot.investigation_packet import compile_investigation_packet, messages_from_conversation
from app.services.copilot.recommend import default_verification_steps
from app.services.copilot.status import normalize_decision_status
from app.services.json_util import parse_json


def debug_decision(event: str, **fields: object) -> None:
    if os.environ.get("ADPILOT_DEBUG") != "1":
        return
    payload = {key: value for key, value in fields.items() if value is not None}
    logging.getLogger("adpilot.decision").info("%s %s", event, payload)


def _scrub_window_copy(value: str | None) -> str:
    if not value:
        return ""
    text = value
    for prefix in (
        "Selected window · ",
        "Prior comparison · ",
        "Snapshot window · ",
        "Comparison window · ",
        "Full snapshot · ",
        "Recent 7 days · ",
        "Previous 7 days · ",
        "Full range · ",
        "近 7 天 · ",
        "前 7 天 · ",
        "全周期 · ",
    ):
        text = text.replace(prefix, "")
    return text


def _parse_scrubbed(raw: str | None, default):
    return parse_json(_scrub_window_copy(raw), default)

RecommendationStatus = Literal["draft", "confirmed", "dismissed"]

ACTIVE = {"confirmed"}


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def recommendation_id_for(finding_id: str) -> str:
    meta = get_dataset_meta()
    source_version = (meta.sourceSha256 or "")[:12] if meta.sourceSha256 else None
    return f"rec:{finding_id}:{source_version}" if source_version else f"rec:{finding_id}"


def decision_id_for(recommendation_id: str) -> str:
    return f"decision:{recommendation_id}"


def list_stored_recommendations(account_id: str, window_id: str) -> list[dict]:
    migrate_legacy_decision_statuses()
    rows = get_db().execute(
        "SELECT * FROM recommendations WHERE account_id = ? AND window_id = ? ORDER BY updated_at ASC",
        (account_id, window_id),
    ).fetchall()
    return [map_recommendation(dict(r)) for r in rows]


def get_stored_recommendation(rec_id: str) -> dict | None:
    migrate_legacy_decision_statuses()
    row = get_db().execute("SELECT * FROM recommendations WHERE id = ?", (rec_id,)).fetchone()
    return map_recommendation(dict(row)) if row else None


def overlay_recommendation(finding: dict, stored: dict | None, live: dict | None) -> dict | None:
    if stored:
        debug_decision(
            "overlay-keep-stored",
            findingId=finding.get("id"),
            recommendationId=stored.get("id"),
            decisionId=stored.get("decisionId"),
            datasetVersion=stored.get("datasetVersion"),
        )
        return stored
    if not live:
        return stored
    return {
        "id": recommendation_id_for(finding["id"]),
        "findingId": finding["id"],
        "status": "draft",
        "userEdited": False,
        "proposal": live,
        "original": live,
        "decisionId": None,
        "updatedAt": None,
        "datasetVersion": get_dataset_meta().datasetVersion,
        "findingSnapshot": None,
    }


def save_recommendation_edit(input_data: dict) -> dict:
    finding = input_data["finding"]
    rec_id = recommendation_id_for(finding["id"])
    existing = get_stored_recommendation(rec_id)
    if existing and existing.get("status") == "confirmed":
        raise CopilotError("A confirmed recommendation cannot be edited. Create a revision instead of changing the confirmed record.")
    now = _iso_now()
    original = existing["original"] if existing else input_data["original"]
    edited = 0 if input_data.get("userEdited") is False else 1
    get_db().execute(
        """INSERT INTO recommendations (
          id, finding_id, account_id, window_id, campaign_id, status, user_edited, original_json, proposed_json, finding_json, created_at, updated_at, dataset_version
        ) VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status='draft', user_edited=excluded.user_edited, proposed_json=excluded.proposed_json,
          finding_json=excluded.finding_json, dataset_version=excluded.dataset_version, updated_at=excluded.updated_at""",
        (
            rec_id,
            finding["id"],
            finding["accountId"],
            finding["windowId"],
            finding["campaignId"],
            edited,
            json.dumps(original),
            json.dumps(input_data["proposal"]),
            json.dumps(finding),
            now,
            now,
            get_dataset_meta().datasetVersion,
        ),
    )
    get_db().commit()
    record_audit(
        input_data["actorId"],
        "edit",
        "recommendation",
        rec_id,
        "Saved the current recommendation draft"
        if input_data.get("userEdited") is False
        else "Edited recommendation action or rationale",
    )
    return get_stored_recommendation(rec_id)


def confirm_recommendation(input_data: dict) -> dict:
    proposal = input_data["proposal"]
    if not proposal.get("guardrail", {}).get("passed"):
        raise CopilotError("The recommendation has not passed validation and cannot be confirmed.")
    finding = input_data["finding"]
    rec_id = recommendation_id_for(finding["id"])
    existing = get_stored_recommendation(rec_id)
    if existing and existing.get("status") == "confirmed":
        raise CopilotError("This recommendation is already confirmed.")
    now = _iso_now()
    original = existing["original"] if existing else input_data["original"]
    diff = build_diff(original, proposal)
    decision_id = decision_id_for(rec_id)
    baseline = {
        "windowLabel": finding.get("windowLabel"),
        "campaignId": finding.get("campaignId"),
        "state": proposal.get("currentState"),
        "recordedAt": now,
    }
    db = get_db()
    db.execute(
        """INSERT INTO recommendations (
          id, finding_id, account_id, window_id, campaign_id, status, user_edited, original_json, proposed_json, finding_json, created_at, updated_at, dataset_version
        ) VALUES (?,?,?,?,?,'confirmed',?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status='confirmed', proposed_json=excluded.proposed_json,
          finding_json=excluded.finding_json, dataset_version=excluded.dataset_version, updated_at=excluded.updated_at""",
        (
            rec_id,
            finding["id"],
            finding["accountId"],
            finding["windowId"],
            finding["campaignId"],
            1 if existing and existing.get("userEdited") else 0,
            json.dumps(original),
            json.dumps(proposal),
            json.dumps(finding),
            now,
            now,
            get_dataset_meta().datasetVersion,
        ),
    )
    db.execute(
        """INSERT INTO decisions (
          id, recommendation_id, status, modified, diff_json, actor_id, confirmed_at, dismissed_at, exported_at,
          execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at
        ) VALUES (?,?,'confirmed',?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status='confirmed', modified=excluded.modified, diff_json=excluded.diff_json,
          actor_id=excluded.actor_id, confirmed_at=excluded.confirmed_at, dismissed_at=NULL,
          baseline_json=excluded.baseline_json, updated_at=excluded.updated_at""",
        (decision_id, rec_id, 1 if diff else 0, json.dumps(diff), input_data["actorId"], now, json.dumps(baseline), now, now),
    )
    snapshot_finding(finding, now)
    db.commit()
    record_audit(input_data["actorId"], "confirm", "decision", decision_id, "Confirmed the recommendation. Confirmation is not platform execution.")
    return get_decision(decision_id)


def confirm_decision(decision_id: str, actor_id: str) -> dict:
    decision = require_decision(decision_id)
    if decision["status"] == "confirmed":
        raise CopilotError("This decision is already confirmed.")
    now = _iso_now()
    baseline = {
        "windowLabel": decision["windowLabel"],
        "campaignId": decision["campaignId"],
        "state": decision["current"]["currentState"],
        "recordedAt": now,
    }
    db = get_db()
    db.execute(
        "UPDATE decisions SET status='confirmed', actor_id=?, confirmed_at=?, dismissed_at=NULL, baseline_json=?, updated_at=? WHERE id=?",
        (actor_id, now, json.dumps(baseline), now, decision_id),
    )
    db.execute("UPDATE recommendations SET status='confirmed', updated_at=? WHERE id=?", (now, decision["recommendationId"]))
    db.commit()
    record_audit(actor_id, "confirm", "decision", decision_id, "Confirmed the recommendation. Confirmation is not platform execution.")
    return get_decision(decision_id)


def _merge_notes(current: dict | None, extra: dict | None = None) -> dict:
    notes = {
        "verificationSteps": (current or {}).get("verificationSteps") or "",
        "userNotes": (current or {}).get("userNotes") or "",
        "dismissalReason": (current or {}).get("dismissalReason") or "",
        "investigationTrail": (current or {}).get("investigationTrail") or [],
    }
    if extra:
        notes.update({key: value for key, value in extra.items() if value is not None})
    return notes


def _packet_for_finding(finding: dict, conversation_id: str | None, proposal: dict | None) -> dict | None:
    if not conversation_id:
        return compile_investigation_packet(
            {
                "campaignName": finding.get("campaignName"),
                "title": f"{finding.get('title') or ''} {(proposal or {}).get('title') or ''}",
                "findingType": finding.get("type"),
                "severity": finding.get("severity"),
                "evidence": finding.get("evidence") or (proposal or {}).get("evidence") or [],
                "conversationId": conversation_id,
                "windowId": finding.get("windowId"),
                "datasetVersion": get_dataset_meta().datasetVersion,
                "actionType": (proposal or {}).get("actionType"),
            },
            [],
        )
    messages = messages_from_conversation(get_db(), conversation_id)
    return compile_investigation_packet(
        {
            "campaignName": finding.get("campaignName"),
            "title": f"{finding.get('title') or ''} {(proposal or {}).get('title') or ''}",
            "findingType": finding.get("type"),
            "severity": finding.get("severity"),
            "evidence": finding.get("evidence") or (proposal or {}).get("evidence") or [],
            "conversationId": conversation_id,
            "windowId": finding.get("windowId"),
            "datasetVersion": get_dataset_meta().datasetVersion,
            "actionType": (proposal or {}).get("actionType"),
        },
        messages,
    )


def dismiss_recommendation(rec_id: str, actor_id: str, reason: str | None = None) -> dict:
    stored = require_recommendation(rec_id)
    if stored["status"] == "confirmed":
        raise CopilotError("A confirmed recommendation cannot be dismissed. Create a revision instead.")
    if stored["status"] == "dismissed":
        raise CopilotError("This recommendation is already dismissed.")
    now = _iso_now()
    decision_id = decision_id_for(rec_id)
    current = get_decision(decision_id)
    notes = _merge_notes(current, {"dismissalReason": (reason or "").strip()})
    db = get_db()
    db.execute("UPDATE recommendations SET status='dismissed', updated_at=? WHERE id=?", (now, rec_id))
    db.execute(
        """INSERT INTO decisions (
          id, recommendation_id, status, modified, diff_json, actor_id, confirmed_at, dismissed_at, exported_at,
          execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at, notes_json
        ) VALUES (?,?,'dismissed',0,'[]',?,NULL,?,NULL,NULL,NULL,NULL,NULL,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status='dismissed', actor_id=excluded.actor_id, dismissed_at=excluded.dismissed_at, notes_json=excluded.notes_json, updated_at=excluded.updated_at""",
        (decision_id, rec_id, actor_id, now, now, now, json.dumps(notes)),
    )
    db.commit()
    record_audit(actor_id, "dismiss", "decision", decision_id, "Dismissed the recommendation. No platform change was made.")
    return get_decision(decision_id)


def dismiss_decision(decision_id: str, actor_id: str, reason: str | None = None) -> dict:
    decision = require_decision(decision_id)
    if decision["status"] == "confirmed":
        raise CopilotError("A confirmed decision cannot be dismissed. Create a revision if the recommendation needs to change.")
    return dismiss_recommendation(decision["recommendationId"], actor_id, reason)


def compile_investigation_reason(conversation_id: str | None = None) -> str | None:
    if not conversation_id:
        return None
    packet = compile_investigation_packet({"campaignName": "This campaign", "conversationId": conversation_id}, messages_from_conversation(get_db(), conversation_id))
    return packet.get("reason")


def ensure_draft_decision(input_data: dict) -> dict:
    finding = input_data["finding"]
    rec_id = recommendation_id_for(finding["id"])
    existing = get_stored_recommendation(rec_id)
    decision_id = decision_id_for(rec_id)
    current = get_decision(decision_id)
    conversation_id = input_data.get("conversationId")
    now = _iso_now()
    if current and current.get("status") == "draft":
        if conversation_id and not current.get("conversationId"):
            get_db().execute("UPDATE decisions SET conversation_id=?, updated_at=? WHERE id=?", (conversation_id, now, decision_id))
            get_db().commit()
        return get_decision(decision_id)
    if current:
        rec_id = f"{rec_id}:open:{int(datetime.now(timezone.utc).timestamp() * 1000)}"
        existing = None
        decision_id = decision_id_for(rec_id)
        current = None
    packet = None if (existing or {}).get("userEdited") else _packet_for_finding(finding, conversation_id, (existing or {}).get("proposal") or input_data.get("proposal"))
    proposal = (existing or {}).get("proposal") or input_data["proposal"]
    if packet:
        proposal = {**proposal, "title": packet["title"], "reason": packet["reason"]}
    if existing and existing.get("status") == "draft":
        save_recommendation_edit(
            {
                "finding": finding,
                "original": (existing or {}).get("original") or input_data["original"],
                "proposal": proposal,
                "actorId": input_data["actorId"],
                "userEdited": input_data.get("userEdited", (existing or {}).get("userEdited", False)),
            }
        )
    else:
        get_db().execute(
            """INSERT INTO recommendations (
              id, finding_id, account_id, window_id, campaign_id, status, user_edited, original_json, proposed_json, finding_json, created_at, updated_at, dataset_version
            ) VALUES (?,?,?,?,?,'draft',0,?,?,?,?,?,?)""",
            (
                rec_id,
                finding["id"],
                finding["accountId"],
                finding["windowId"],
                finding["campaignId"],
                json.dumps((existing or {}).get("original") or input_data["original"]),
                json.dumps(proposal),
                json.dumps(finding),
                now,
                now,
                get_dataset_meta().datasetVersion,
            ),
        )
    notes = _merge_notes(
        None,
        {
            "verificationSteps": "\n".join((packet or {}).get("verificationSteps") or []) or default_verification_steps(finding),
            "userNotes": "",
            "investigationTrail": (packet or {}).get("trail") or [],
        },
    )
    get_db().execute(
        """INSERT INTO decisions (
          id, recommendation_id, status, modified, diff_json, actor_id, confirmed_at, dismissed_at, exported_at,
          execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at,
          conversation_id, parent_decision_id, notes_json
        ) VALUES (?,?,'draft',0,'[]',?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?,?,NULL,?)""",
        (decision_id, rec_id, input_data["actorId"], now, now, conversation_id, json.dumps(notes)),
    )
    get_db().commit()
    record_audit(input_data["actorId"], "draft", "decision", decision_id, "Opened a review decision draft. No platform change was made.")
    return get_decision(decision_id)


def update_draft_decision(input_data: dict) -> dict:
    decision = require_decision(input_data["id"])
    if decision["status"] != "draft":
        raise CopilotError("Only a draft decision can be edited.")
    rec = require_recommendation(decision["recommendationId"])
    now = _iso_now()
    proposal = {**rec["proposal"]}
    if input_data.get("title"):
        proposal["title"] = input_data["title"].strip()
    if input_data.get("reason"):
        proposal["reason"] = input_data["reason"].strip()
    diff = build_diff(rec["original"], proposal)
    notes = _merge_notes(
        decision,
        {
            "verificationSteps": input_data.get("verificationSteps", decision.get("verificationSteps") or ""),
            "userNotes": input_data.get("userNotes", decision.get("userNotes") or ""),
        },
    )
    db = get_db()
    db.execute("UPDATE recommendations SET user_edited=1, proposed_json=?, updated_at=? WHERE id=?", (json.dumps(proposal), now, rec["id"]))
    db.execute(
        "UPDATE decisions SET modified=?, diff_json=?, notes_json=?, updated_at=? WHERE id=?",
        (1 if diff else 0, json.dumps(diff), json.dumps(notes), now, decision["id"]),
    )
    db.commit()
    record_audit(input_data["actorId"], "edit", "decision", decision["id"], "Edited the draft recommendation. Original evidence was left unchanged.")
    return get_decision(decision["id"])


def create_revision_decision(decision_id: str, actor_id: str) -> dict:
    parent = require_decision(decision_id)
    if parent["status"] != "confirmed":
        raise CopilotError("Only a confirmed decision can be revised.")
    open_revision = get_db().execute(
        "SELECT id FROM decisions WHERE parent_decision_id = ? AND status = 'draft' ORDER BY created_at DESC",
        (parent["id"],),
    ).fetchone()
    if open_revision:
        return require_decision(open_revision["id"])
    rec = require_recommendation(parent["recommendationId"])
    finding = rec.get("findingSnapshot")
    if not finding:
        raise CopilotError("The original finding snapshot is missing for this decision.")
    now = _iso_now()
    rec_id = f"{recommendation_id_for(finding['id'])}:rev:{int(datetime.now(timezone.utc).timestamp() * 1000)}"
    new_id = decision_id_for(rec_id)
    notes = {
        "verificationSteps": parent.get("verificationSteps") or default_verification_steps(finding),
        "userNotes": "",
    }
    db = get_db()
    db.execute(
        """INSERT INTO recommendations (
          id, finding_id, account_id, window_id, campaign_id, status, user_edited, original_json, proposed_json, finding_json, created_at, updated_at, dataset_version
        ) VALUES (?,?,?,?,?,'draft',0,?,?,?,?,?,?)""",
        (
            rec_id,
            finding["id"],
            finding["accountId"],
            finding["windowId"],
            finding["campaignId"],
            json.dumps(rec["original"]),
            json.dumps(rec["proposal"]),
            json.dumps(finding),
            now,
            now,
            rec.get("datasetVersion"),
        ),
    )
    db.execute(
        """INSERT INTO decisions (
          id, recommendation_id, status, modified, diff_json, actor_id, confirmed_at, dismissed_at, exported_at,
          execution_mode, execution_result, observation_json, baseline_json, created_at, updated_at,
          conversation_id, parent_decision_id, notes_json
        ) VALUES (?,?,'draft',0,'[]',?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?,?,?,?)""",
        (new_id, rec_id, actor_id, now, now, parent.get("conversationId"), parent["id"], json.dumps(notes)),
    )
    db.commit()
    record_audit(actor_id, "revise", "decision", new_id, f"Opened a revision of {parent['id']}. The confirmed record was left unchanged.")
    return get_decision(new_id)


def export_decision(decision_id: str, actor_id: str) -> dict:
    decision = require_decision(decision_id)
    if decision["status"] != "confirmed":
        raise CopilotError("Confirm the decision before exporting a record.")
    document = render_document(decision)
    now = _iso_now()
    observation = waiting_observation(decision)
    db = get_db()
    db.execute(
        "UPDATE decisions SET execution_mode='export', execution_result=?, observation_json=?, exported_at=?, updated_at=? WHERE id=?",
        (document, json.dumps(observation), now, now, decision_id),
    )
    db.commit()
    record_audit(actor_id, "export", "decision", decision_id, "Exported decision record. This is not platform execution.")
    return {"decision": get_decision(decision_id), "document": document}


def list_decisions(status: str | None = None) -> list[dict]:
    migrate_legacy_decision_statuses()
    rows = get_db().execute("SELECT * FROM decisions ORDER BY updated_at DESC LIMIT 200").fetchall()
    views = [v for r in rows if (v := hydrate_decision(dict(r)))]
    if not status or status == "all":
        return views
    return [v for v in views if v["status"] == status]


def get_decision(decision_id: str) -> dict | None:
    migrate_legacy_decision_statuses()
    row = get_db().execute("SELECT * FROM decisions WHERE id = ?", (decision_id,)).fetchone()
    return hydrate_decision(dict(row)) if row else None


def count_draft_decisions() -> int:
    migrate_legacy_decision_statuses()
    row = get_db().execute("SELECT COUNT(*) AS count FROM decisions WHERE status='draft'").fetchone()
    return int(row["count"] or 0)


count_pending_decisions = count_draft_decisions


def snapshot_findings(findings: list[dict]) -> None:
    now = _iso_now()
    for finding in findings:
        snapshot_finding(finding, now)


def snapshot_finding(finding: dict, now: str) -> None:
    get_db().execute(
        """INSERT INTO findings (id, account_id, window_id, campaign_id, finding_type, severity, payload, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET severity=excluded.severity, payload=excluded.payload, updated_at=excluded.updated_at""",
        (
            finding["id"],
            finding["accountId"],
            finding["windowId"],
            finding["campaignId"],
            finding["type"],
            finding["severity"],
            json.dumps(finding),
            now,
            now,
        ),
    )
    get_db().commit()


def migrate_legacy_decision_statuses() -> None:
    db = get_db()
    db.execute(
        "UPDATE decisions SET exported_at = COALESCE(exported_at, updated_at) WHERE (status = 'exported' OR execution_mode = 'export') AND exported_at IS NULL"
    )
    db.execute("UPDATE recommendations SET status = 'confirmed' WHERE status IN ('approved', 'exported', 'externally_marked')")
    db.execute("UPDATE recommendations SET status = 'dismissed' WHERE status = 'rejected'")
    db.execute("UPDATE recommendations SET status = 'draft' WHERE status IN ('pending_review', 'expired')")
    db.execute("UPDATE decisions SET status = 'confirmed' WHERE status IN ('approved', 'exported', 'externally_marked')")
    db.execute("UPDATE decisions SET status = 'dismissed' WHERE status = 'rejected'")
    db.execute("UPDATE decisions SET status = 'draft' WHERE status IN ('pending_review', 'expired')")
    db.commit()


def require_recommendation(rec_id: str) -> dict:
    stored = get_stored_recommendation(rec_id)
    if not stored:
        raise CopilotError("No recommendation record to act on. Edit or submit one first.", 404)
    return stored


def require_decision(decision_id: str) -> dict:
    decision = get_decision(decision_id)
    if not decision:
        raise CopilotError("Decision not found.", 404)
    return decision


def map_recommendation(row: dict) -> dict:
    decision = get_db().execute(
        "SELECT id, status FROM decisions WHERE recommendation_id = ?", (row["id"],)
    ).fetchone()
    decision_id = decision["id"] if decision else None
    return {
        "id": row["id"],
        "findingId": row["finding_id"],
        "status": normalize_decision_status(row["status"]),
        "userEdited": bool(row["user_edited"]),
        "proposal": english_stored_proposal(_parse_scrubbed(row["proposed_json"], {})),
        "original": english_stored_proposal(_parse_scrubbed(row["original_json"], {})),
        "decisionId": decision_id,
        "updatedAt": row["updated_at"],
        "datasetVersion": row.get("dataset_version"),
        "findingSnapshot": _parse_scrubbed(row["finding_json"], None),
    }


def hydrate_decision(row: dict) -> dict | None:
    recommendation = get_db().execute(
        "SELECT * FROM recommendations WHERE id = ?", (row["recommendation_id"],)
    ).fetchone()
    if not recommendation:
        return None
    finding = _parse_scrubbed(recommendation["finding_json"], {})
    current = english_stored_proposal(_parse_scrubbed(recommendation["proposed_json"], {}))
    original = english_stored_proposal(_parse_scrubbed(recommendation["original_json"], {}))
    audit_rows = get_db().execute(
        "SELECT * FROM audit_events WHERE entity_id = ? OR entity_id = ? ORDER BY created_at DESC LIMIT 12",
        (row["id"], row["recommendation_id"]),
    ).fetchall()
    baseline = parse_json(row["baseline_json"], None)
    status = normalize_decision_status(row["status"])
    confirmed_at = row["confirmed_at"] if status == "confirmed" else None
    dismissed_at = row["dismissed_at"] if status == "dismissed" else None
    exported_at = row["exported_at"] if "exported_at" in row.keys() else None
    if not exported_at and row["execution_mode"] == "export":
        exported_at = row["updated_at"]
    notes = parse_json(row["notes_json"] if "notes_json" in row.keys() else None, {}) or {}
    generated_at = get_dataset_meta().generatedAt
    timeline_note = None
    if confirmed_at and generated_at and confirmed_at < generated_at:
        timeline_note = "This confirmation timestamp is earlier than the current imported snapshot. Original timestamps were kept."
    return {
        "id": row["id"],
        "recommendationId": row["recommendation_id"],
        "findingId": recommendation["finding_id"],
        "status": status,
        "campaignId": recommendation["campaign_id"],
        "campaignName": finding.get("campaignName"),
        "title": current.get("title"),
        "modified": bool(row["modified"]),
        "diff": parse_json(row["diff_json"], []),
        "original": original,
        "current": current,
        "actorId": row["actor_id"],
        "actorName": _actor_display_name(row["actor_id"]),
        "confirmedAt": confirmed_at,
        "dismissedAt": dismissed_at,
        "exportedAt": exported_at,
        "executionMode": row["execution_mode"],
        "executionResult": row["execution_result"],
        "observation": _english_observation(parse_json(row["observation_json"], None)),
        "baselineLabel": english_proposal_text((baseline or {}).get("state") if baseline else None) or None,
        "windowLabel": _recovered_window(finding.get("windowLabel"), recommendation["window_id"] if "window_id" in recommendation.keys() else finding.get("windowId"), "label"),
        "windowId": recommendation["window_id"] if "window_id" in recommendation.keys() else finding.get("windowId"),
        "datasetVersion": recommendation["dataset_version"] if "dataset_version" in recommendation.keys() else None,
        "compareLabel": _recovered_window(finding.get("compareLabel"), recommendation["window_id"] if "window_id" in recommendation.keys() else finding.get("windowId"), "compare"),
        "findingType": finding.get("type"),
        "severity": finding.get("severity"),
        "conversationId": row["conversation_id"] if "conversation_id" in row.keys() else None,
        "parentDecisionId": row["parent_decision_id"] if "parent_decision_id" in row.keys() else None,
        "verificationSteps": notes.get("verificationSteps") or "",
        "userNotes": notes.get("userNotes") or "",
        "dismissalReason": notes.get("dismissalReason") or "",
        "investigationTrail": notes.get("investigationTrail") or [],
        "timelineNote": timeline_note,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "highRisk": current.get("riskLevel") == "high"
        or current.get("actionType") in ("pause_candidate", "decrease_priority"),
        "findingRaw": finding.get("raw"),
        "audit": [
            {
                "id": e["id"],
                "actorId": e["actor_id"],
                "actorName": _actor_display_name(e["actor_id"]),
                "action": e["action"],
                "createdAt": e["created_at"],
                "detail": english_proposal_text(e["detail"]) or e["detail"],
            }
            for e in audit_rows
        ],
    }


def build_diff(original: dict, proposed: dict) -> list[dict]:
    diff = []
    if original.get("actionType") != proposed.get("actionType"):
        diff.append(
            {
                "label": "Action",
                "before": ACTION_LABEL.get(original.get("actionType"), original.get("actionType")),
                "after": ACTION_LABEL.get(proposed.get("actionType"), proposed.get("actionType")),
            }
        )
    if original.get("reason") != proposed.get("reason"):
        diff.append({"label": "Rationale", "before": original.get("reason"), "after": proposed.get("reason")})
    return diff


_EVIDENCE_LABELS = {
    "曝光": "Impressions",
    "点击": "Clicks",
    "转化": "Conversion-linked clicks",
    "转化关联点击": "Conversion-linked clicks",
    "点击后转化率": "Conversion-link rate",
    "点击后转化关联率": "Conversion-link rate",
    "成本指数": "Cost index",
    "成本指数总值": "Cost index total",
    "单次点击成本指数": "Average cost index per click",
}


def _english_evidence_label(value: object) -> str:
    label = str(value or "")
    return _EVIDENCE_LABELS.get(label) or ("Verified metric" if has_chinese(label) else label)


LOST_COPY = "The original Chinese copy was replaced with an English decision record."


def _recovered_window(value, window_id, kind: str):
    cleaned = english_window_label(value) or (value if value and LOST_COPY not in value and not has_chinese(value) else "")
    if cleaned:
        return cleaned
    resolved = resolve_window(window_id, get_dataset_meta())
    if not resolved:
        return value or ("" if kind == "label" else None)
    return resolved.label if kind == "label" else resolved.compareLabel


def _english_observation(value):
    if not value:
        return None
    if isinstance(value, dict):
        return {
            **value,
            "baselineLabel": english_proposal_text(value.get("baselineLabel")) or value.get("baselineLabel"),
            "note": english_proposal_text(value.get("note")) or value.get("note"),
        }
    return value


def waiting_observation(decision: dict) -> dict:
    return {
        "state": "waiting_for_new_sync",
        "baselineLabel": decision.get("baselineLabel") or decision["current"].get("currentState"),
        "note": "The confirmation-time baseline is recorded. No newer dataset exists, so the current window cannot be presented as an outcome caused by this action.",
    }


def render_document(decision: dict) -> str:
    current = decision["current"]
    action_type = current.get("actionType")
    lines = [
        "AdPilot decision record",
        "This file records a user-confirmed investigation recommendation. Export is not platform execution.",
        f"Campaign: {decision['campaignName']}",
        f"Window: {english_window_label(decision.get('windowLabel')) or decision.get('windowLabel')}",
        f"Decision ID: {decision.get('id')}",
        f"Status: {decision.get('status')}",
        f"Action: {ACTION_LABEL.get(action_type, action_type)}",
        f"Observed state: {english_proposal_text(current.get('currentState'), action_type)}",
        f"Proposal: {english_proposal_text(current.get('proposedState'), action_type)}",
        f"Rationale: {english_proposal_text(current.get('reason'), action_type)}",
        f"Risk: {english_proposal_text(current.get('riskNote'), action_type)}",
        f"Evidence level: {current.get('evidenceLevel')}",
    ]
    for item in (current.get("evidence") or [])[:8]:
        prior = f" (prior {item.get('baseline')})" if item.get("baseline") else ""
        delta = f" {item.get('delta')}" if item.get("delta") else ""
        lines.append(f"Evidence {_english_evidence_label(item.get('label'))}: {item.get('value')}{prior}{delta}")
    lines.extend([
        "The proposal was materially changed from the original." if decision.get("modified") else "The proposal matches the original AI draft.",
        "No advertising-platform write integration is available, so AdPilot does not apply this plan.",
    ])
    return "\n".join(lines)


def record_audit(actor_id: str, action: str, entity_type: str, entity_id: str, detail: str) -> None:
    get_db().execute(
        "INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)",
        (next_id(), actor_id, action, entity_type, entity_id, detail, _iso_now()),
    )
    get_db().commit()


def action_allowed(value: str) -> bool:
    return value in ("increase_priority", "decrease_priority", "hold", "review", "pause_candidate")


def _actor_display_name(actor_id: str | None) -> str | None:
    if not actor_id:
        return None
    if actor_id == "system":
        return "System"
    row = get_db().execute("SELECT name FROM actors WHERE id = ?", (actor_id,)).fetchone()
    if row and row["name"]:
        return row["name"]
    return "User"

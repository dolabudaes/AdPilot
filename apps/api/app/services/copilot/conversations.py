from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone

from app.db import get_db
from app.errors import CopilotError
from app.services.analytics import get_dataset_meta
from app.services.copilot.investigate.run import investigate_turn
from app.services.copilot.issue_titles import investigation_conversation_title, summarize_conversation_title
from app.services.copilot.service import build_product_model
from app.services.json_util import parse_json
from app.services.copilot.english_copy import english_proposal_text

CONTEXT = {"account", "investigation", "proposal", "general"}
_schema_ready = False
KINDS = {"chat", "metrics", "investigation", "proposal", "diff", "review"}


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_message_columns() -> None:
    global _schema_ready
    if _schema_ready:
        return
    db = get_db()
    cols = {r[1] for r in db.execute("PRAGMA table_info(conversation_messages)").fetchall()}
    if "answer_kind" not in cols:
        db.execute("ALTER TABLE conversation_messages ADD COLUMN answer_kind TEXT")
    if "review_ready" not in cols:
        db.execute("ALTER TABLE conversation_messages ADD COLUMN review_ready INTEGER DEFAULT 0")
    db.commit()
    _schema_ready = True


def map_conversation(row: dict) -> dict:
    status = "archived" if row["status"] == "archived" else "active"
    ctx = row["context_type"] if row["context_type"] in CONTEXT else "general"
    prompt = row.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        prompt = prompt.strip()
    else:
        prompt = None
    return {
        "id": row["id"],
        "accountId": row["account_id"],
        "ownerId": row["owner_id"],
        "title": row["title"],
        "titleCustom": bool(row["title_custom"]),
        "contextType": ctx,
        "campaignId": row["campaign_id"],
        "findingId": row["finding_id"],
        "windowId": row["window_id"],
        "compareLabel": row["compare_label"],
        "snapshotAt": row["snapshot_at"],
        "snapshotLabel": row["snapshot_label"],
        "status": status,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "prompt": prompt,
        "isDemo": bool(row.get("is_demo")),
        "demoKey": row.get("demo_key") or None,
        "datasetGeneratedAt": row.get("dataset_generated_at") or None,
    }


def list_conversations(owner_id: str, account_id: str, query: str = "") -> list[dict]:
    needle = f"%{query.strip()}%"
    rows = get_db().execute(
        """SELECT c.*,
          (SELECT m.content FROM conversation_messages m
            WHERE m.conversation_id = c.id AND m.role = 'user'
            ORDER BY m.created_at ASC LIMIT 1) AS prompt
         FROM conversations c
         WHERE c.account_id = ? AND c.status = 'active'
           AND EXISTS (
             SELECT 1 FROM conversation_messages m
             WHERE m.conversation_id = c.id AND m.role = 'user' AND length(trim(m.content)) > 0
               AND lower(replace(replace(replace(trim(m.content), '.', ''), '!', ''), '?', '')) NOT IN ('hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening')
           )
           AND (? = '%%' OR c.title LIKE ? OR IFNULL(c.campaign_id, '') LIKE ?
             OR IFNULL((SELECT m.content FROM conversation_messages m
               WHERE m.conversation_id = c.id AND m.role = 'user'
               ORDER BY m.created_at ASC LIMIT 1), '') LIKE ?)
         ORDER BY c.updated_at DESC LIMIT 50""",
        (account_id, needle, needle, needle, needle),
    ).fetchall()
    out = []
    for r in rows:
        row = dict(r)
        if not row.get("title_custom") and (row.get("prompt") or "").strip() and is_placeholder_title(row["title"]):
            user_prompts = get_db().execute(
                "SELECT content FROM conversation_messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at ASC",
                (row["id"],),
            ).fetchall()
            substantive = None
            for up in user_prompts:
                item = (up[0] or "").strip()
                if item and summarize_conversation_title(item, row.get("campaign_id")) != "New conversation":
                    substantive = item
                    break
            nxt = summarize_conversation_title(substantive or row["prompt"], row.get("campaign_id"))
            if nxt != row["title"]:
                get_db().execute("UPDATE conversations SET title = ? WHERE id = ? AND title_custom = 0", (nxt, row["id"]))
                get_db().commit()
                row["title"] = nxt
        out.append(map_conversation(row))
    return out


def list_conversation_links(owner_id: str, account_id: str) -> dict[str, str]:
    ensure_message_columns()
    rows = get_db().execute(
        """SELECT c.id, c.finding_id,
          (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
         WHERE c.account_id = ? AND c.status = 'active' AND c.finding_id IS NOT NULL
         ORDER BY message_count DESC, c.updated_at DESC""",
        (account_id,),
    ).fetchall()
    links: dict[str, str] = {}
    for row in rows:
        fid, cid, count = row["finding_id"], row["id"], row["message_count"]
        if count > 0 and fid not in links:
            links[fid] = cid
    return links


def is_placeholder_title(title: str) -> bool:
    return title in ("New conversation", "New investigation", "Account-wide investigation") or bool(
        re.search(r" · New investigation$", title)
    )


def user_message_count(conversation_id: str) -> int:
    ensure_message_columns()
    row = get_db().execute(
        "SELECT COUNT(*) AS count FROM conversation_messages WHERE conversation_id = ? AND role = 'user'",
        (conversation_id,),
    ).fetchone()
    return row["count"] if row else 0


def message_count(conversation_id: str) -> int:
    ensure_message_columns()
    row = get_db().execute(
        "SELECT COUNT(*) AS count FROM conversation_messages WHERE conversation_id = ?",
        (conversation_id,),
    ).fetchone()
    return row["count"] if row else 0


def list_finding_conversations(owner_id: str, account_id: str, finding_id: str, window_id: str) -> list[dict]:
    rows = get_db().execute(
        """SELECT * FROM conversations
         WHERE account_id = ? AND finding_id = ? AND window_id = ? AND status = 'active'
         ORDER BY updated_at DESC""",
        (account_id, finding_id, window_id),
    ).fetchall()
    return [dict(r) for r in rows]


def open_conversation(input_data: dict) -> dict:
    model = build_product_model({"accountId": input_data.get("accountId"), "windowId": input_data.get("windowId")})
    if not model.get("ready") or model["account"]["id"] != input_data.get("accountId"):
        raise CopilotError("No bindable data for this account.", 404)
    account_wide = input_data.get("contextType") == "account"
    finding = None
    if not account_wide and input_data.get("findingId"):
        finding = next((f for f in model["findings"] if f["id"] == input_data["findingId"]), None)
    if not finding and input_data.get("campaignId"):
        finding = next((f for f in model["findings"] if f["campaignId"] == input_data["campaignId"]), None)
    if not account_wide and input_data.get("findingId") and not finding:
        raise CopilotError("This finding is not available in the selected window.", 404)
    campaign = None
    if not account_wide and input_data.get("campaignId"):
        campaign = next((c for c in model["campaigns"] if c["id"] == input_data["campaignId"]), None)
        if not campaign:
            raise CopilotError("This campaign is not available in the selected window.", 404)
    window_key = (model.get("window") or {}).get("id") or input_data.get("windowId")
    if input_data.get("demoKey"):
        existing = get_db().execute("SELECT * FROM conversations WHERE demo_key = ? LIMIT 1", (input_data["demoKey"],)).fetchone()
        if existing:
            return map_conversation(dict(existing))
    if finding:
        candidates = list_finding_conversations(input_data["ownerId"], input_data["accountId"], finding["id"], window_key)
        with_messages = [r for r in candidates if message_count(r["id"]) > 0]
        resume = False if input_data.get("forceNew") else input_data.get("resume") is not False
        if resume and with_messages:
            return map_conversation(with_messages[0])
        if resume and candidates:
            return map_conversation(candidates[0])
        if not input_data.get("forceNew"):
            empty = next((r for r in candidates if message_count(r["id"]) == 0), None)
            if empty:
                return map_conversation(empty)
    now = _iso_now()
    cid = str(uuid.uuid4())
    if input_data.get("contextType") in CONTEXT:
        ctx = input_data["contextType"]
    elif finding or campaign:
        ctx = "investigation"
    else:
        ctx = "account"
    if finding:
        title = investigation_conversation_title(finding)
    elif campaign:
        title = f"{campaign['name']} · New investigation"
    else:
        title = "Account-wide investigation"
    meta = get_dataset_meta()
    get_db().execute(
        """INSERT INTO conversations (
          id, account_id, owner_id, title, title_custom, context_type, campaign_id, finding_id, window_id,
          compare_label, snapshot_at, snapshot_label, status, created_at, updated_at, is_demo, demo_key, dataset_generated_at
        ) VALUES (?,?,?,?,0,?,?,?,?,?,?,?,'active',?,?,?,?,?)""",
        (
            cid,
            model["account"]["id"],
            input_data["ownerId"],
            title,
            ctx,
            (finding or {}).get("campaignId") or (campaign or {}).get("id"),
            (finding or {}).get("id"),
            window_key,
            (model.get("window") or {}).get("compareLabel"),
            model.get("generatedAt"),
            "Imported dataset snapshot" if model.get("stale") else "Current window",
            now,
            now,
            1 if input_data.get("demoKey") else 0,
            input_data.get("demoKey"),
            meta.datasetVersion or model.get("generatedAt"),
        ),
    )
    get_db().commit()
    return require_conversation(cid, input_data["ownerId"])


def get_conversation_for_actor(cid: str, owner_id: str) -> dict:
    row = get_db().execute("SELECT * FROM conversations WHERE id = ?", (cid,)).fetchone()
    if not row:
        raise CopilotError("Conversation not found.", 404)
    return map_conversation(dict(row))


def get_conversation_for_account(cid: str, account_id: str) -> dict:
    row = get_db().execute("SELECT * FROM conversations WHERE id = ? AND account_id = ?", (cid, account_id)).fetchone()
    if not row:
        raise CopilotError("Conversation not found.", 404)
    return map_conversation(dict(row))


def require_conversation(cid: str, owner_id: str) -> dict:
    return get_conversation_for_actor(cid, owner_id)


def rename_conversation(cid: str, owner_id: str, title: str) -> dict:
    require_conversation(cid, owner_id)
    nxt = title.strip()
    if len(nxt) < 2 or len(nxt) > 80:
        raise CopilotError("Title must be between 2 and 80 characters.", 404)
    now = _iso_now()
    get_db().execute("UPDATE conversations SET title=?, title_custom=1, updated_at=? WHERE id=?", (nxt, now, cid))
    get_db().commit()
    return require_conversation(cid, owner_id)


def archive_conversation(cid: str, owner_id: str) -> dict:
    conv = require_conversation(cid, owner_id)
    now = _iso_now()
    get_db().execute("UPDATE conversations SET status='archived', updated_at=? WHERE id=?", (now, cid))
    get_db().commit()
    return {**conv, "status": "archived", "updatedAt": now}


def list_messages(cid: str, owner_id: str, before: str | None = None, limit: int = 40) -> dict:
    ensure_message_columns()
    require_conversation(cid, owner_id)
    size = min(max(limit, 1), 80)
    if before:
        rows = get_db().execute(
            "SELECT * FROM conversation_messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?",
            (cid, before, size + 1),
        ).fetchall()
    else:
        rows = get_db().execute(
            "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
            (cid, size + 1),
        ).fetchall()
    has_more = len(rows) > size
    messages = [map_message(dict(r)) for r in rows[:size]]
    messages.reverse()
    return {"messages": messages, "hasMore": has_more}


ISO_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T")
SCHEMA_VERSION = re.compile(r"^schema-\d+:([a-f0-9]{32,})$", re.I)


def _content_key(value: str) -> str | None:
    schema = SCHEMA_VERSION.match(value)
    if schema:
        return schema.group(1).lower()
    if re.fullmatch(r"[a-f0-9]{64}", value, re.I):
        return value.lower()
    return None


def snapshots_match(recorded: str | None, live: list[str | None]) -> bool:
    if not recorded:
        return True
    versions = [item for item in live if item]
    if not versions:
        return True
    if recorded in versions:
        return True
    if any(recorded in item or item in recorded for item in versions):
        return True
    recorded_key = _content_key(recorded)
    if recorded_key and any(_content_key(item) == recorded_key or recorded_key in item.lower() for item in versions):
        return True
    if ISO_TIMESTAMP.match(recorded) and not recorded_key:
        return True
    return False


def assert_current_dataset(conversation: dict) -> None:
    model = build_product_model({"accountId": conversation["accountId"], "windowId": conversation["windowId"]})
    meta = get_dataset_meta()
    saved = conversation.get("datasetGeneratedAt")
    live = [meta.datasetVersion, meta.generatedAt, model.get("generatedAt"), meta.sourceSha256]
    if saved and not snapshots_match(saved, live):
        raise CopilotError(
            "This investigation uses an older dataset snapshot. Its history remains available, but start a new investigation to analyze the current snapshot without mixing evidence versions.",
            409,
        )


async def send_message(cid: str, owner_id: str, content: str, client_key: str) -> dict:
    ensure_message_columns()
    conversation = require_conversation(cid, owner_id)
    if conversation["status"] != "active":
        raise CopilotError("This conversation is archived.", 400)
    text = content.strip()
    key = client_key.strip()
    if not key or len(key) > 80:
        raise CopilotError("Missing message identifier.", 400)
    if len(text) < 1:
        raise CopilotError("Enter a question to continue.", 400)
    existing = find_by_key(cid, key)
    next_title = summarize_conversation_title(text, conversation.get("campaignId"))
    should_replace = is_placeholder_title(conversation["title"]) and next_title != "New conversation"
    if not existing and not conversation["titleCustom"] and (user_message_count(cid) == 0 or should_replace):
        now = _iso_now()
        get_db().execute("UPDATE conversations SET title=?, updated_at=? WHERE id=?", (next_title, now, cid))
        get_db().commit()
        conversation["title"] = next_title
    assistant_key = f"{key}:assistant"
    existing_assistant = find_by_key(cid, assistant_key)
    if existing and existing_assistant and existing_assistant["status"] == "completed":
        return {"conversation": conversation, "user": existing, "assistant": existing_assistant, "replayed": True}
    assert_current_dataset(conversation)
    user = existing or insert_message(cid, "user", text, "completed", key)
    assistant = existing_assistant or insert_message(cid, "assistant", "", "pending", assistant_key)
    return await finish_assistant(conversation, user, assistant)


async def retry_message(cid: str, owner_id: str, client_key: str) -> dict:
    conversation = require_conversation(cid, owner_id)
    user = find_by_key(cid, client_key)
    if not user or user["role"] != "user":
        raise CopilotError("No user message found to retry.", 404)
    assistant_key = f"{client_key}:assistant"
    assistant = find_by_key(cid, assistant_key)
    if assistant and assistant["status"] == "completed":
        return {"conversation": conversation, "user": user, "assistant": assistant, "replayed": True}
    assert_current_dataset(conversation)
    if not assistant:
        assistant = insert_message(cid, "assistant", "", "pending", assistant_key)
    else:
        get_db().execute("UPDATE conversation_messages SET status='pending', error=NULL, content='' WHERE id=?", (assistant["id"],))
        get_db().commit()
        assistant = find_by_key(cid, assistant_key)
    return await finish_assistant(conversation, user, assistant)


async def finish_assistant(conversation: dict, user: dict, assistant: dict) -> dict:
    try:
        page = list_messages(conversation["id"], conversation["ownerId"], None, 12)
        history = [
            {"role": m["role"], "content": m["content"]}
            for m in page["messages"]
            if m["id"] not in (user["id"], assistant["id"]) and m["status"] == "completed"
        ][-8:]
        assisted = await investigate_turn(
            {
                "question": user["content"],
                "accountId": conversation["accountId"],
                "windowId": conversation["windowId"],
                "campaignId": conversation["campaignId"],
                "findingId": conversation["findingId"],
                "history": history,
            }
        )
        ans = assisted["answer"]
        now = _iso_now()
        get_db().execute(
            """UPDATE conversation_messages SET content=?, status='completed', evidence_json=?, sections_json=?, revision_json=?, mode=?, answer_kind=?, review_ready=?, error=NULL WHERE id=?""",
            (
                ans["answer"],
                json.dumps(
                    {
                        "cites": ans.get("evidence"),
                        "series": ans.get("series"),
                        "tools": ans.get("tools"),
                        "steps": ans.get("steps"),
                        "statusTrail": ans.get("statusTrail"),
                        "investigation": ans.get("investigation"),
                        "runtime": ans.get("runtime"),
                    }
                ),
                json.dumps(ans.get("sections") or []),
                json.dumps(ans["revision"]) if ans.get("revision") else None,
                assisted["mode"],
                ans.get("kind"),
                1 if ans.get("reviewReady") else 0,
                assistant["id"],
            ),
        )
        get_db().execute("UPDATE conversations SET updated_at=? WHERE id=?", (now, conversation["id"]))
        get_db().commit()
        saved = find_by_key(conversation["id"], assistant.get("clientKey") or "")
        assistant_out = saved or assistant
        if saved:
            assistant_out = {**saved, "note": assisted.get("note")}
        else:
            assistant_out = {
                **assistant,
                "content": ans["answer"],
                "status": "completed",
                "note": assisted.get("note"),
                "kind": ans.get("kind"),
                "reviewReady": ans.get("reviewReady"),
            }
        return {
            "conversation": require_conversation(conversation["id"], conversation["ownerId"]),
            "user": user,
            "assistant": assistant_out,
            "replayed": False,
        }
    except CopilotError:
        raise
    except Exception as e:
        msg = str(e)
        get_db().execute("UPDATE conversation_messages SET status='failed', error=?, content='' WHERE id=?", (msg, assistant["id"]))
        get_db().commit()
        raise CopilotError(msg, 500) from e


def insert_message(conversation_id: str, role: str, content: str, status: str, client_key: str) -> dict:
    mid = str(uuid.uuid4())
    now = _iso_now()
    get_db().execute(
        """INSERT INTO conversation_messages (
          id, conversation_id, role, content, status, client_key, evidence_json, sections_json, revision_json, mode, error, created_at
        ) VALUES (?,?,?,?,?,?, NULL, NULL, NULL, NULL, NULL, ?)""",
        (mid, conversation_id, role, content, status, client_key, now),
    )
    get_db().commit()
    saved = find_by_key(conversation_id, client_key)
    if not saved:
        raise CopilotError("Message was not saved.", 500)
    return saved


def find_by_key(conversation_id: str, client_key: str) -> dict | None:
    if not client_key:
        return None
    row = get_db().execute(
        "SELECT * FROM conversation_messages WHERE conversation_id = ? AND client_key = ?",
        (conversation_id, client_key),
    ).fetchone()
    return map_message(dict(row)) if row else None


def map_message(row: dict) -> dict:
    payload = parse_payload(row.get("evidence_json"))
    sections = parse_json(row.get("sections_json"), [])
    role = "assistant" if row["role"] == "assistant" else "user"
    original_status = row["status"] if row["status"] in ("pending", "failed") else "completed"
    displayed = english_proposal_text(row["content"]) or row["content"]
    if role == "assistant" and original_status == "completed":
        recovered = recover_assistant_content(displayed, payload, sections)
    else:
        recovered = {"content": displayed, "recovered": False}
    recovery_failed = role == "assistant" and original_status == "completed" and not recovered["content"]
    status = "failed" if recovery_failed else original_status
    error = row.get("error")
    if recovery_failed:
        error = "The historical answer is unavailable. Re-analyze the original question to create a new answer from the current verified data."
    recovery_state = "unrecoverable" if recovery_failed else ("reconstructed" if recovered.get("recovered") else "none")
    mode = row.get("mode")
    if mode not in ("ai", "rule", "agent", "llm", "llm_partial"):
        mode = None
    return {
        "id": row["id"],
        "conversationId": row["conversation_id"],
        "role": role,
        "content": recovered["content"],
        "status": status,
        "clientKey": row["client_key"],
        **payload,
        "sections": sections,
        "revision": parse_json(row.get("revision_json"), None),
        "kind": row["answer_kind"] if row.get("answer_kind") in KINDS else "chat",
        "reviewReady": bool(row.get("review_ready")),
        "mode": mode,
        "note": None,
        "error": error,
        "recoveryState": recovery_state,
        "createdAt": row["created_at"],
    }


def recover_assistant_content(content: str, payload: dict, sections: list) -> dict:
    if not is_unreadable_assistant_content(content):
        return {"content": content, "recovered": False}
    inv = payload.get("investigation") or {}
    pres = inv.get("presentation") or {}
    finding = (pres.get("finding") or "").strip()
    if finding and not has_chinese(finding) and not is_placeholder_answer(finding):
        return {"content": finding, "recovered": True}
    facts = [
        item["text"].strip()
        for item in (inv.get("structured") or {}).get("observedFacts") or []
        if item.get("verified") and item.get("text", "").strip() and not has_chinese(item["text"])
    ]
    if facts:
        return {"content": " ".join(facts[:3]), "recovered": True}
    section_facts = [
        item.strip()
        for section in sections
        for item in (section.get("items") or [])
        if item and item.strip() and not has_chinese(item)
    ]
    if section_facts:
        return {"content": " ".join(section_facts[:3]), "recovered": True}
    return {"content": "", "recovered": False}


def is_unreadable_assistant_content(value: str) -> bool:
    return not value or not value.strip() or is_placeholder_answer(value)


def is_placeholder_answer(value: str) -> bool:
    return bool(
        re.search(
            r"could not translate.*saved response|investigation complete for|response is available in the structured findings|structured findings below|no campaign named campaign show\b",
            value,
            re.I,
        )
    )


def has_chinese(value: str) -> bool:
    return bool(re.search(r"[\u3400-\u9fff]", value))


def parse_payload(value):
    parsed = parse_json(value, [])
    if isinstance(parsed, list):
        return {"evidence": parsed, "series": None, "tools": [], "steps": [], "statusTrail": [], "investigation": None, "runtime": None}
    if isinstance(parsed, dict):
        return {
            "evidence": parsed.get("cites") or parsed.get("evidence") or [],
            "series": parsed.get("series"),
            "tools": parsed.get("tools") or [],
            "steps": parsed.get("steps") or [],
            "statusTrail": parsed.get("statusTrail") or [],
            "investigation": parsed.get("investigation"),
            "runtime": parsed.get("runtime"),
        }
    return {"evidence": [], "series": None, "tools": [], "steps": [], "statusTrail": [], "investigation": None, "runtime": None}


def rerun_availability(cid: str, owner_id: str) -> dict:
    conversation = require_conversation(cid, owner_id)
    model = build_product_model({"accountId": conversation["accountId"], "windowId": conversation["windowId"]})
    newer = bool(model.get("generatedAt") and conversation.get("snapshotAt") and model["generatedAt"] != conversation["snapshotAt"])
    return {
        "available": newer,
        "message": "A newer imported snapshot is available for this window." if newer else "No newer snapshot is available; prior conclusions cannot be refreshed automatically.",
        "snapshotAt": conversation.get("snapshotAt"),
        "currentAt": model.get("generatedAt"),
    }

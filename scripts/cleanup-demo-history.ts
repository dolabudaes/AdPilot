import { getDb } from "../apps/web/lib/db";

const db = getDb();
const automated = db
  .prepare(
    `
  SELECT m.id, m.conversation_id
  FROM conversation_messages m
  WHERE m.client_key LIKE 'check-%' OR m.client_key LIKE 'launch-story-%'
`
  )
  .all() as Array<{ id: string; conversation_id: string }>;

const affected = [...new Set(automated.map((row) => row.conversation_id))];
const now = new Date().toISOString();

const clean = db.transaction(() => {
  if (automated.length) {
    const remove = db.prepare(`DELETE FROM conversation_messages WHERE id = ?`);
    for (const row of automated) remove.run(row.id);
  }

  for (const conversationId of affected) {
    const remaining = db
      .prepare(`SELECT COUNT(*) AS count FROM conversation_messages WHERE conversation_id = ?`)
      .get(conversationId) as { count: number };
    if (remaining.count === 0) {
      db.prepare(`UPDATE conversations SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'`).run(now, conversationId);
    } else {
      db.prepare(
        `
        UPDATE conversations
        SET updated_at = COALESCE((SELECT MAX(created_at) FROM conversation_messages WHERE conversation_id = ?), created_at)
        WHERE id = ?
      `
      ).run(conversationId, conversationId);
    }
  }
});
clean();

const leftoverD = removeLegacyCampaignDConfirmation(db);

console.log(`Removed ${automated.length} automated test messages from ${affected.length} conversation${affected.length === 1 ? "" : "s"}.`);
if (leftoverD) console.log("Removed leftover Campaign D confirmation that was migrated from the old approval demo, not a user Confirm.");

function removeLegacyCampaignDConfirmation(database: ReturnType<typeof getDb>) {
  const recId = "rec:finding:criteo-demo:recent_7d:Campaign D:cvr_anomaly";
  const decisionId = `decision:${recId}`;
  const findingId = "finding:criteo-demo:recent_7d:Campaign D:cvr_anomaly";
  const row = database.prepare(`SELECT id, conversation_id FROM decisions WHERE id = ?`).get(decisionId) as { id: string; conversation_id: string | null } | undefined;
  if (!row) return false;
  const legacy = database
    .prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE entity_id IN (?, ?) AND action IN ('approve', 'submit', 'mark_external')`)
    .get(decisionId, recId) as { count: number };
  if (!legacy.count) return false;
  const wipe = database.transaction(() => {
    database.prepare(`DELETE FROM strategy_versions WHERE recommendation_id = ? OR finding_id = ?`).run(recId, findingId);
    database.prepare(`DELETE FROM audit_events WHERE entity_id IN (?, ?, ?)`).run(decisionId, recId, findingId);
    database.prepare(`DELETE FROM decisions WHERE id = ?`).run(decisionId);
    database.prepare(`DELETE FROM recommendations WHERE id = ?`).run(recId);
    database.prepare(`DELETE FROM findings WHERE id = ?`).run(findingId);
  });
  wipe();
  return true;
}

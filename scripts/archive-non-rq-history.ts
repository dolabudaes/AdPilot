import { getDb } from "../apps/web/lib/db";

const db = getDb();
const now = new Date().toISOString();
const keep = new Set(["Campaign R", "Campaign Q"]);

const active = db.prepare(`SELECT id, title, campaign_id FROM conversations WHERE status = 'active'`).all() as Array<{
  id: string;
  title: string;
  campaign_id: string | null;
}>;

const tx = db.transaction(() => {
  const archive = db.prepare(`UPDATE conversations SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'`);
  let count = 0;
  for (const row of active) {
    if (row.campaign_id && keep.has(row.campaign_id)) continue;
    archive.run(now, row.id);
    count += 1;
    console.log(`archived ${row.campaign_id || "account"}: ${row.title}`);
  }
  return count;
});

const archived = tx();
const remaining = db.prepare(`SELECT title, campaign_id FROM conversations WHERE status = 'active'`).all() as Array<{ title: string; campaign_id: string | null }>;
console.log(`Archived ${archived} investigation${archived === 1 ? "" : "s"}. Remaining: ${remaining.map((row) => `${row.campaign_id}: ${row.title}`).join("; ") || "none"}`);

import { getDb } from "../apps/web/lib/db";
import { openConversation, renameConversation, sendMessage } from "../apps/web/lib/copilot/conversations";
import { buildProductModel } from "../apps/web/lib/copilot/service";
import { listStrategyVersions, saveStrategyVersion } from "../apps/web/lib/copilot/strategy-versions";

const accountId = "criteo-demo";
const windowId = "recent_7d";
const ownerId = "user";
const db = getDb();
const model = buildProductModel({ accountId, windowId });
const finding = model.findings.find((item) => item.campaignId === "Campaign R");
if (!finding) throw new Error("Campaign R finding is unavailable in the demo window.");

const legacyDemo = db.prepare(`
  SELECT c.id FROM conversations c
  WHERE c.owner_id = ? AND c.title = 'Campaign R conversion decline'
    AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id AND m.client_key = 'r-invest-1')
    AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id AND m.client_key = 'tool-bad:assistant')
`).get(ownerId) as { id: string } | undefined;
if (legacyDemo) db.prepare(`UPDATE conversations SET status = 'archived' WHERE id = ?`).run(legacyDemo.id);

const existing = db.prepare(`
  SELECT c.id FROM conversations c JOIN conversation_messages m ON m.conversation_id = c.id
  WHERE c.owner_id = ? AND m.client_key = 'demo-story-r-v3-1' LIMIT 1
`).get(ownerId) as { id: string } | undefined;
const conversation = existing
  ? { id: existing.id }
  : openConversation({ ownerId, accountId, windowId, findingId: finding.id, campaignId: finding.campaignId, contextType: "investigation", forceNew: true });
if (!existing) renameConversation(conversation.id, ownerId, "Campaign R conversion-efficiency review");

const turns = [
  "Why is Campaign R flagged as high priority?",
  "Was the decline sustained, or concentrated on a few dates?",
  "How did Campaign D perform in the same window?",
  "Could a creative change have caused both Campaign R and Campaign D to decline?",
  "Which campaign should we review first, and what should we verify?",
  "Compile all prior investigation evidence into one human-review recommendation and create a Decision Draft.",
];
let finalAssistantId: string | null = null;
let finalAnswer = "";
for (const [index, question] of turns.entries()) {
  const result = await sendMessage(conversation.id, ownerId, question, `demo-story-r-v3-${index + 1}`);
  finalAssistantId = result.assistant.id;
  finalAnswer = result.assistant.content;
}

if (!listStrategyVersions(finding.id).some((version) => version.conversationId === conversation.id) && finding.recommendation) {
  saveStrategyVersion({
    findingId: finding.id,
    actionType: finding.recommendation.proposal.actionType,
    reason: finalAnswer,
    actorId: ownerId,
    source: "ai",
    conversationId: conversation.id,
    messageId: finalAssistantId,
  });
}

console.log(`Campaign R demo investigation ready: ${conversation.id} (${turns.length} verified turns).`);

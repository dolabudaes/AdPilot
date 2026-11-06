import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { FINDING_LABEL, STATUS_LABEL } from "@/lib/copilot/labels";
import { buildProductModel } from "@/lib/copilot/service";
import type { ConversationRecord, MessageRecord } from "@/lib/copilot/conversations";

export type InvestigationReport = {
  id: string;
  conversationId: string;
  accountId: string;
  campaignId: string | null;
  findingId: string | null;
  windowId: string;
  snapshotAt: string | null;
  title: string;
  html: string;
  createdAt: string;
};

export function buildReportHtml(conversation: ConversationRecord, messages: MessageRecord[], findingTitle: string | null) {
  const assistant = messages.filter((item) => item.role === "assistant" && item.status === "completed");
  const last = assistant.at(-1);
  const investigation = last?.investigation;
  const model = buildProductModel({ accountId: conversation.accountId, windowId: conversation.windowId });
  const finding = conversation.findingId ? model.findings.find((item) => item.id === conversation.findingId) : null;
  const reviewStatus = finding?.recommendation ? STATUS_LABEL[finding.recommendation.status] || finding.recommendation.status : "No linked recommendation";
  const decisionId = finding?.recommendation?.decisionId || null;
  const evidenceIds = (last?.evidence || []).map((item) => item.id).filter(Boolean);
  const structuredIds = last?.investigation?.structured?.supportingEvidenceIds || [];

  const sections = [
    { title: "Executive Summary", body: englishReportText(last?.content, "The investigation has not produced a complete response yet.") },
    {
      title: "Campaign Performance Overview",
      body: `${conversation.campaignId || "Account"} · ${conversation.windowId}${conversation.compareLabel ? ` · ${conversation.compareLabel}` : ""} · Historical snapshot ${conversation.snapshotAt || "unavailable"}. This is not live platform data.`,
    },
    { title: "Key Findings", items: englishItems(investigation?.found, ["Performance changed materially in the selected analysis window.", "The available metrics confirm the change but do not establish a root cause."]) },
    { title: "Supporting Metrics", items: last?.evidence.map((item) => `${englishMetric(item.label)}: ${item.value}${item.relative ? ` · ${item.relative}` : ""}`) || [] },
    { title: "Data Limitations", items: ["Budget, bid, revenue, ROAS, creative, audience, landing-page, and verified spend fields are unavailable."] },
    { title: "Recommended Next Steps", items: englishItems(investigation?.nextSteps, ["Review the campaign context and daily trend before changing delivery.", "Any formal action still requires human review."]) },
    { title: "Human Review Status", body: `${reviewStatus}. This report does not submit, approve, execute, or modify a formal decision.` },
    {
      title: "Linked Records",
      body: `Finding ${conversation.findingId || "none"} · Campaign ${conversation.campaignId || "none"} · Window ${conversation.windowId} · Snapshot ${conversation.snapshotAt || "unavailable"} · Decision ${decisionId || "none"} · Evidence snapshot ${evidenceIds.length} ids · Structured evidence ${structuredIds.length} ids.`,
    },
  ];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(conversation.title)} — AdPilot Report</title>
  <style>
    body { font-family: "Segoe UI", system-ui, sans-serif; color: #0f172a; max-width: 880px; margin: 2rem auto; line-height: 1.55; }
    h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.1rem; margin-top: 1.75rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.35rem; }
    .meta { color: #64748b; font-size: 0.92rem; }
    ul { padding-left: 1.2rem; }
    .badge { display: inline-block; background: #f1f5f9; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.85rem; }
    @media print { body { margin: 0.5in; } }
  </style>
</head>
<body>
  <p class="badge">Imported Demo Dataset · Investigation Report</p>
  <h1>${escapeHtml(findingTitle || conversation.title)}</h1>
  <p class="meta">AdPilot · ${escapeHtml(conversation.accountId)} · Conversation ${escapeHtml(conversation.id)}</p>
  ${sections
    .map((section) => {
      if ("body" in section && section.body) return `<h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.body)}</p>`;
      const items = "items" in section ? section.items : [];
      return `<h2>${escapeHtml(section.title)}</h2><ul>${(items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    })
    .join("")}
  <p class="meta">Created ${new Date().toISOString()} · This report does not represent verified financial impact or a confirmed root cause.</p>
</body>
</html>`;
  return html;
}

export function saveInvestigationReport(conversation: ConversationRecord, messages: MessageRecord[]) {
  const model = buildProductModel({ accountId: conversation.accountId, windowId: conversation.windowId });
  const finding = conversation.findingId ? model.findings.find((item) => item.id === conversation.findingId) : null;
  const title = finding ? `${finding.campaignName} — ${FINDING_LABEL[finding.type]} Investigation Report` : `AdPilot Investigation Report`;
  const html = buildReportHtml(conversation, messages, title);
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO investigation_reports (id, conversation_id, account_id, campaign_id, finding_id, window_id, snapshot_at, title, html, created_at)
       VALUES (@id, @conversationId, @accountId, @campaignId, @findingId, @windowId, @snapshotAt, @title, @html, @now)`
    )
    .run({
      id,
      conversationId: conversation.id,
      accountId: conversation.accountId,
      campaignId: conversation.campaignId,
      findingId: conversation.findingId,
      windowId: conversation.windowId,
      snapshotAt: conversation.snapshotAt,
      title,
      html,
      now,
    });
  return { id, title, html, createdAt: now };
}

function hasChinese(value: string) { return /[\u3400-\u9fff]/.test(value); }
function englishReportText(value: string | undefined, fallback: string) { return value && !hasChinese(value) ? value : fallback; }
function englishItems(items: string[] | undefined, fallback: string[]) { return items?.length && items.every((item) => !hasChinese(item)) ? items : fallback; }
function englishMetric(value: string) {
  const labels: Record<string, string> = { "曝光": "Impressions", "点击": "Clicks", "点击率": "CTR", "转化": "Conversion-linked clicks", "转化关联点击": "Conversion-linked clicks", "点击后转化率": "Post-click conversion-link rate", "点击后转化关联率": "Post-click conversion-link rate", "归因转化": "Attributed conversion links", "成本指数": "Cost index", "成本指数总值": "Cost index total", "单次点击成本指数": "Average cost index per click", "归因占比": "Attribution-link share" };
  return labels[value] || (hasChinese(value) ? "Supporting metric" : value);
}

export function getInvestigationReport(id: string) {
  const row = getDb().prepare(`SELECT * FROM investigation_reports WHERE id = ?`).get(id) as
    | {
        id: string;
        conversation_id: string;
        account_id: string;
        campaign_id: string | null;
        finding_id: string | null;
        window_id: string;
        snapshot_at: string | null;
        title: string;
        html: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    accountId: row.account_id,
    campaignId: row.campaign_id,
    findingId: row.finding_id,
    windowId: row.window_id,
    snapshotAt: row.snapshot_at,
    title: row.title,
    html: row.html,
    createdAt: row.created_at,
  } satisfies InvestigationReport;
}

export function listReportsForConversation(conversationId: string) {
  const rows = getDb()
    .prepare(`SELECT id, title, created_at FROM investigation_reports WHERE conversation_id = ? ORDER BY created_at DESC`)
    .all(conversationId) as Array<{ id: string; title: string; created_at: string }>;
  return rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at }));
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

import { randomUUID } from "node:crypto";
import { getDatasetMeta } from "@/lib/analytics";
import { getDb } from "@/lib/db";
import type { CopilotSection } from "./answers";
import { investigateTurn } from "./investigate/run";
import { buildProductModel } from "./service";
import { CopilotError } from "./store";
import type { TrendPoint } from "./types";
import type { InvestigationRuntimeTrace, ToolName } from "./investigate/types";
import type { ActionType } from "@/lib/analytics/types";
import { investigationConversationTitle, summarizeConversationTitle } from "./issue-titles";
import { snapshotsMatch } from "./pin-window";
import { englishProposalText, hasChinese } from "./english-copy";

export type ConversationStatus = "active" | "archived";
export type ContextType = "account" | "investigation" | "proposal" | "general";
export type MessageStatus = "pending" | "completed" | "failed";

export type ConversationRecord = {
  id: string;
  accountId: string;
  ownerId: string;
  title: string;
  titleCustom: boolean;
  contextType: ContextType;
  campaignId: string | null;
  findingId: string | null;
  windowId: string;
  compareLabel: string | null;
  snapshotAt: string | null;
  snapshotLabel: string | null;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  prompt: string | null;
  isDemo: boolean;
  demoKey: string | null;
  datasetGeneratedAt: string | null;
};

export type MessageRecord = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  clientKey: string | null;
  evidence: Array<{ label: string; value: string; source: string; id?: string; baseline?: string | null; absolute?: string | null; relative?: string | null; points?: string | null; windowLabel?: string; compareLabel?: string | null; metric?: string }>;
  sections: CopilotSection[];
  series: TrendPoint[] | null;
  tools: ToolName[];
  steps: Array<{ tool: ToolName; label: string; ok: boolean; summary: string; picker?: "llm" | "rule" }>;
  statusTrail: string[];
  investigation: {
    found: string[];
    explanations: string[];
    cannotDetermine: string[];
    nextSteps: string[];
    structured?: {
      observedFacts: Array<{ text: string; verified: boolean; evidenceIds: string[] }>;
      hypotheses: Array<{ text: string; unverified: true }>;
      supportingEvidenceIds: string[];
      missingEvidence: string[];
      recommendedChecks: string[];
      proposedActions: string[];
      limitations: string[];
    };
    synthesisStatus?: string;
    presentation?: import("./investigate/types").InvestigationPresentation;
  } | null;
  revision: { actionType: ActionType; reason: string; label: string } | null;
  kind: "chat" | "metrics" | "investigation" | "proposal" | "diff" | "review";
  reviewReady: boolean;
  mode: "rule" | "ai" | "agent" | "llm" | "llm_partial" | null;
  runtime: InvestigationRuntimeTrace | null;
  note: string | null;
  error: string | null;
  recoveryState: "none" | "reconstructed" | "unrecoverable";
  createdAt: string;
};

type ConversationRow = {
  id: string;
  account_id: string;
  owner_id: string;
  title: string;
  title_custom: number;
  context_type: string;
  campaign_id: string | null;
  finding_id: string | null;
  window_id: string;
  compare_label: string | null;
  snapshot_at: string | null;
  snapshot_label: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  prompt?: string | null;
  is_demo?: number | null;
  demo_key?: string | null;
  dataset_generated_at?: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  status: string;
  client_key: string | null;
  evidence_json: string | null;
  sections_json: string | null;
  revision_json: string | null;
  mode: string | null;
  answer_kind: string | null;
  review_ready: number | null;
  error: string | null;
  created_at: string;
};

const CONTEXT = new Set<ContextType>(["account", "investigation", "proposal", "general"]);
let schemaReady = false;

function ensureMessageColumns() {
  if (schemaReady) return;
  const database = getDb();
  const columns = database.prepare(`PRAGMA table_info(conversation_messages)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "answer_kind")) database.exec(`ALTER TABLE conversation_messages ADD COLUMN answer_kind TEXT`);
  if (!columns.some((column) => column.name === "review_ready")) database.exec(`ALTER TABLE conversation_messages ADD COLUMN review_ready INTEGER DEFAULT 0`);
  schemaReady = true;
}

export function listConversations(ownerId: string, accountId: string, query = "") {
  const needle = `%${query.trim()}%`;
  const rows = getDb()
    .prepare(
      `SELECT c.*,
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
       ORDER BY c.updated_at DESC LIMIT 50`
    )
    .all(accountId, needle, needle, needle, needle) as ConversationRow[];
  for (const row of rows) {
    if (row.title_custom || !row.prompt?.trim()) continue;
    if (!isPlaceholderTitle(row.title)) continue;
    const userPrompts = getDb()
      .prepare(`SELECT content FROM conversation_messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at ASC`)
      .all(row.id) as Array<{ content: string }>;
    const substantive = userPrompts
      .map((item) => item.content?.trim())
      .find((item) => item && summarizeConversationTitle(item, row.campaign_id) !== "New conversation");
    const next = summarizeConversationTitle(substantive || row.prompt, row.campaign_id);
    if (next === row.title) continue;
    getDb().prepare(`UPDATE conversations SET title = ? WHERE id = ? AND title_custom = 0`).run(next, row.id);
    row.title = next;
  }
  return rows.map(mapConversation);
}

export function listConversationLinks(ownerId: string, accountId: string) {
  ensureMessageColumns();
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.finding_id,
        (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
       WHERE c.account_id = ? AND c.status = 'active' AND c.finding_id IS NOT NULL
       ORDER BY message_count DESC, c.updated_at DESC`
    )
    .all(accountId) as Array<{ id: string; finding_id: string; message_count: number }>;
  const links: Record<string, string> = {};
  for (const row of rows) {
    if (row.message_count > 0 && !links[row.finding_id]) links[row.finding_id] = row.id;
  }
  return links;
}

function titleFromPrompt(text: string, campaignName?: string | null) {
  return summarizeConversationTitle(text, campaignName);
}

function isPlaceholderTitle(title: string) {
  return title === "New conversation" || title === "New investigation" || title === "Account-wide investigation" || / · New investigation$/.test(title);
}

function userMessageCount(conversationId: string) {
  ensureMessageColumns();
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM conversation_messages WHERE conversation_id = ? AND role = 'user'`).get(conversationId) as { count: number };
  return row?.count || 0;
}

function messageCount(conversationId: string) {
  ensureMessageColumns();
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM conversation_messages WHERE conversation_id = ?`).get(conversationId) as { count: number };
  return row?.count || 0;
}

function listFindingConversations(ownerId: string, accountId: string, findingId: string, windowId: string) {
  return getDb()
    .prepare(
      `SELECT * FROM conversations
       WHERE account_id = ? AND finding_id = ? AND window_id = ? AND status = 'active'
       ORDER BY updated_at DESC`
    )
    .all(accountId, findingId, windowId) as ConversationRow[];
}

export function openConversation(input: {
  ownerId: string;
  accountId: string;
  windowId: string;
  findingId?: string | null;
  campaignId?: string | null;
  contextType?: ContextType;
  resume?: boolean;
  forceNew?: boolean;
  demoKey?: string | null;
}) {
  const model = buildProductModel({ accountId: input.accountId, windowId: input.windowId });
  if (!model.ready || model.account.id !== input.accountId) {
    throw new CopilotError("No bindable data for this account.", 404);
  }
  const accountWide = input.contextType === "account";
  let finding = accountWide ? null : input.findingId ? model.findings.find((item) => item.id === input.findingId) : null;
  if (!finding && input.campaignId) {
    finding = model.findings.find((item) => item.campaignId === input.campaignId) || null;
  }
  if (!accountWide && input.findingId && !finding) throw new CopilotError("This finding is not available in the selected window.", 404);
  const campaign = !accountWide && input.campaignId ? model.campaigns.find((item) => item.id === input.campaignId) || null : null;
  if (!accountWide && input.campaignId && !campaign) throw new CopilotError("This campaign is not available in the selected window.", 404);
  const windowKey = model.window?.id || input.windowId;
  if (input.demoKey) {
    const existingDemo = getDb().prepare(`SELECT * FROM conversations WHERE demo_key = ? LIMIT 1`).get(input.demoKey) as ConversationRow | undefined;
    if (existingDemo) return mapConversation(existingDemo);
  }
  if (finding) {
    const candidates = listFindingConversations(input.ownerId, input.accountId, finding.id, windowKey);
    const withMessages = candidates.filter((row) => messageCount(row.id) > 0);
    const resume = input.forceNew ? false : input.resume !== false;
    if (resume && withMessages.length) return mapConversation(withMessages[0]);
    if (resume && candidates.length) return mapConversation(candidates[0]);
    if (!input.forceNew) {
      const empty = candidates.find((row) => messageCount(row.id) === 0);
      if (empty) return mapConversation(empty);
    }
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const contextType = input.contextType && CONTEXT.has(input.contextType) ? input.contextType : finding || campaign ? "investigation" : "account";
  const title = finding ? investigationConversationTitle(finding) : campaign ? `${campaign.name} · New investigation` : "Account-wide investigation";
  getDb()
    .prepare(
      `INSERT INTO conversations (
        id, account_id, owner_id, title, title_custom, context_type, campaign_id, finding_id, window_id, compare_label, snapshot_at, snapshot_label, status, created_at, updated_at, is_demo, demo_key, dataset_generated_at
      ) VALUES (@id, @accountId, @ownerId, @title, 0, @contextType, @campaignId, @findingId, @windowId, @compareLabel, @snapshotAt, @snapshotLabel, 'active', @now, @now, @isDemo, @demoKey, @datasetGeneratedAt)`
    )
    .run({
      id,
      accountId: model.account.id,
      ownerId: input.ownerId,
      title,
      contextType,
      campaignId: finding?.campaignId || campaign?.id || null,
      findingId: finding?.id || null,
      windowId: model.window?.id || input.windowId,
      compareLabel: model.window?.compareLabel || null,
      snapshotAt: model.generatedAt,
      snapshotLabel: model.stale ? "Imported dataset snapshot" : "Current window",
      now,
      isDemo: input.demoKey ? 1 : 0,
      demoKey: input.demoKey || null,
      datasetGeneratedAt: getDatasetMeta().datasetVersion || model.generatedAt,
    });
  return requireConversation(id, input.ownerId);
}

export function getConversationForActor(id: string, ownerId: string) {
  const row = getDb().prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow | undefined;
  if (!row) throw new CopilotError("Conversation not found.", 404);
  return mapConversation(row);
}

export function getConversationForAccount(id: string, accountId: string) {
  const row = getDb().prepare(`SELECT * FROM conversations WHERE id = ? AND account_id = ?`).get(id, accountId) as ConversationRow | undefined;
  if (!row) throw new CopilotError("Conversation not found.", 404);
  return mapConversation(row);
}

export function requireConversation(id: string, ownerId: string) {
  return getConversationForActor(id, ownerId);
}

export function renameConversation(id: string, ownerId: string, title: string) {
  const conversation = requireConversation(id, ownerId);
  const next = title.trim();
  if (next.length < 2 || next.length > 80) throw new CopilotError("Title must be between 2 and 80 characters.", 404);
  const now = new Date().toISOString();
  getDb().prepare(`UPDATE conversations SET title = ?, title_custom = 1, updated_at = ? WHERE id = ?`).run(next, now, conversation.id);
  return requireConversation(id, ownerId);
}

export function archiveConversation(id: string, ownerId: string) {
  const conversation = requireConversation(id, ownerId);
  const now = new Date().toISOString();
  getDb().prepare(`UPDATE conversations SET status = 'archived', updated_at = ? WHERE id = ?`).run(now, conversation.id);
  return { ...conversation, status: "archived" as const, updatedAt: now };
}

export function listMessages(id: string, ownerId: string, before?: string | null, limit = 40) {
  ensureMessageColumns();
  requireConversation(id, ownerId);
  const size = Math.min(Math.max(limit, 1), 80);
  const rows = before
    ? (getDb()
        .prepare(
          `SELECT * FROM conversation_messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`
        )
        .all(id, before, size + 1) as MessageRow[])
    : (getDb()
        .prepare(`SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(id, size + 1) as MessageRow[]);
  const hasMore = rows.length > size;
  return { messages: rows.slice(0, size).reverse().map(mapMessage), hasMore };
}

export async function sendMessage(id: string, ownerId: string, content: string, clientKey: string) {
  ensureMessageColumns();
  const conversation = requireConversation(id, ownerId);
  if (conversation.status !== "active") throw new CopilotError("This conversation is archived.", 400);
  const text = content.trim();
  const key = clientKey.trim();
  if (!key || key.length > 80) throw new CopilotError("Missing message identifier.", 400);
  if (text.length < 1) throw new CopilotError("Enter a question to continue.", 400);
  const existing = findByKey(id, key);
  const nextTitle = titleFromPrompt(text, conversation.campaignId);
  const shouldReplacePlaceholder = isPlaceholderTitle(conversation.title) && nextTitle !== "New conversation";
  if (!existing && !conversation.titleCustom && (userMessageCount(id) === 0 || shouldReplacePlaceholder)) {
    const now = new Date().toISOString();
    getDb().prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`).run(nextTitle, now, id);
    conversation.title = nextTitle;
  }
  const assistantKey = `${key}:assistant`;
  const existingAssistant = findByKey(id, assistantKey);
  if (existing && existingAssistant?.status === "completed") {
    return { conversation, user: existing, assistant: existingAssistant, replayed: true };
  }
  assertCurrentDataset(conversation);
  const user = existing || insertMessage({
    conversationId: id,
    role: "user",
    content: text,
    status: "completed",
    clientKey: key,
  });
  const assistant = existingAssistant || insertMessage({
    conversationId: id,
    role: "assistant",
    content: "",
    status: "pending",
    clientKey: assistantKey,
  });
  return finishAssistant(conversation, user, assistant);
}

export async function retryMessage(id: string, ownerId: string, clientKey: string) {
  const conversation = requireConversation(id, ownerId);
  const user = findByKey(id, clientKey);
  if (!user || user.role !== "user") throw new CopilotError("No user message found to retry.", 404);
  const assistantKey = `${clientKey}:assistant`;
  let assistant = findByKey(id, assistantKey);
  if (assistant?.status === "completed") return { conversation, user, assistant, replayed: true };
  assertCurrentDataset(conversation);
  if (!assistant) {
    assistant = insertMessage({ conversationId: id, role: "assistant", content: "", status: "pending", clientKey: assistantKey });
  } else {
    getDb().prepare(`UPDATE conversation_messages SET status = 'pending', error = NULL, content = '' WHERE id = ?`).run(assistant.id);
    assistant = { ...assistant, status: "pending", error: null, content: "" };
  }
  return finishAssistant(conversation, user, assistant);
}

function assertCurrentDataset(conversation: ConversationRecord) {
  const model = buildProductModel({ accountId: conversation.accountId, windowId: conversation.windowId });
  const meta = getDatasetMeta();
  const savedVersion = conversation.datasetGeneratedAt;
  if (
    savedVersion &&
    !snapshotsMatch(savedVersion, [meta.datasetVersion, meta.generatedAt, model.generatedAt, meta.sourceSha256])
  ) {
    throw new CopilotError(
      "This investigation uses an older dataset snapshot. Its history remains available, but start a new investigation to analyze the current snapshot without mixing evidence versions.",
      409
    );
  }
}

export function rerunAvailability(id: string, ownerId: string) {
  const conversation = requireConversation(id, ownerId);
  const model = buildProductModel({ accountId: conversation.accountId, windowId: conversation.windowId });
  const newer = Boolean(model.generatedAt && conversation.snapshotAt && model.generatedAt !== conversation.snapshotAt);
  return {
    available: newer,
    message: newer ? "A newer imported snapshot is available for this window." : "No newer snapshot is available; prior conclusions cannot be refreshed automatically.",
    snapshotAt: conversation.snapshotAt,
    currentAt: model.generatedAt,
  };
}

async function finishAssistant(conversation: ConversationRecord, user: MessageRecord, assistant: MessageRecord) {
  try {
    const history = listMessages(conversation.id, conversation.ownerId, null, 12).messages
      .filter((item) => item.id !== user.id && item.id !== assistant.id && item.status === "completed")
      .slice(-8)
      .map((item) => ({ role: item.role as "user" | "assistant", content: item.content }));
    const assisted = await investigateTurn({
      question: user.content,
      accountId: conversation.accountId,
      windowId: conversation.windowId,
      campaignId: conversation.campaignId,
      findingId: conversation.findingId,
      history,
    });
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `UPDATE conversation_messages
         SET content = ?, status = 'completed', evidence_json = ?, sections_json = ?, revision_json = ?, mode = ?, answer_kind = ?, review_ready = ?, error = NULL
         WHERE id = ?`
      )
      .run(
        assisted.answer.answer,
        JSON.stringify({
          cites: assisted.answer.evidence,
          series: assisted.answer.series,
          tools: assisted.answer.tools,
          steps: assisted.answer.steps,
          statusTrail: assisted.answer.statusTrail,
          investigation: assisted.answer.investigation,
          runtime: assisted.answer.runtime,
        }),
        JSON.stringify(assisted.answer.sections),
        assisted.answer.revision ? JSON.stringify(assisted.answer.revision) : null,
        assisted.mode,
        assisted.answer.kind,
        assisted.answer.reviewReady ? 1 : 0,
        assistant.id
      );
    getDb().prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, conversation.id);
    const saved = findByKey(conversation.id, assistant.clientKey || "");
    return {
      conversation: requireConversation(conversation.id, conversation.ownerId),
      user,
      assistant: saved ? { ...saved, note: assisted.note } : { ...assistant, content: assisted.answer.answer, status: "completed" as const, note: assisted.note, kind: assisted.answer.kind, reviewReady: assisted.answer.reviewReady },
      replayed: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Investigation failed.";
    getDb().prepare(`UPDATE conversation_messages SET status = 'failed', error = ?, content = '' WHERE id = ?`).run(message, assistant.id);
    throw new CopilotError(message, 500);
  }
}

function insertMessage(input: {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  clientKey: string;
}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO conversation_messages (
        id, conversation_id, role, content, status, client_key, evidence_json, sections_json, revision_json, mode, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`
    )
    .run(id, input.conversationId, input.role, input.content, input.status, input.clientKey, now);
  const saved = findByKey(input.conversationId, input.clientKey);
  if (!saved) throw new CopilotError("Message was not saved.", 500);
  return saved;
}

function findByKey(conversationId: string, clientKey: string) {
  if (!clientKey) return null;
  const row = getDb()
    .prepare(`SELECT * FROM conversation_messages WHERE conversation_id = ? AND client_key = ?`)
    .get(conversationId, clientKey) as MessageRow | undefined;
  return row ? mapMessage(row) : null;
}

function mapConversation(row: ConversationRow): ConversationRecord {
  const contextType = CONTEXT.has(row.context_type as ContextType) ? (row.context_type as ContextType) : "general";
  const status: ConversationStatus = row.status === "archived" ? "archived" : "active";
  return {
    id: row.id,
    accountId: row.account_id,
    ownerId: row.owner_id,
    title: row.title,
    titleCustom: Boolean(row.title_custom),
    contextType,
    campaignId: row.campaign_id,
    findingId: row.finding_id,
    windowId: row.window_id,
    compareLabel: row.compare_label,
    snapshotAt: row.snapshot_at,
    snapshotLabel: row.snapshot_label,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    prompt: typeof row.prompt === "string" && row.prompt.trim() ? row.prompt.trim() : null,
    isDemo: Boolean(row.is_demo),
    demoKey: row.demo_key || null,
    datasetGeneratedAt: row.dataset_generated_at || null,
  };
}

function mapMessage(row: MessageRow): MessageRecord {
  const payload = parsePayload(row.evidence_json);
  const sections = parse<CopilotSection[]>(row.sections_json, []);
  const role = row.role === "assistant" ? "assistant" : "user";
  const originalStatus: MessageStatus = row.status === "pending" || row.status === "failed" ? row.status : "completed";
  const displayed = englishProposalText(row.content) || row.content;
  const recovered = role === "assistant" && originalStatus === "completed"
    ? recoverAssistantContent(displayed, payload, sections)
    : { content: displayed, recovered: false };
  const recoveryFailed = role === "assistant" && originalStatus === "completed" && !recovered.content;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role,
    content: recovered.content,
    status: recoveryFailed ? "failed" : originalStatus,
    clientKey: row.client_key,
    ...payload,
    sections,
    revision: parse<MessageRecord["revision"]>(row.revision_json, null),
    kind: isKind(row.answer_kind) ? row.answer_kind : "chat",
    reviewReady: Boolean(row.review_ready),
    mode:
      row.mode === "ai" || row.mode === "rule" || row.mode === "agent" || row.mode === "llm" || row.mode === "llm_partial" ? row.mode : null,
    note: null,
    error: recoveryFailed ? "The historical answer is unavailable. Re-analyze the original question to create a new answer from the current verified data." : row.error,
    recoveryState: recoveryFailed ? "unrecoverable" : recovered.recovered ? "reconstructed" : "none",
    createdAt: row.created_at,
  };
}

function recoverAssistantContent(
  content: string,
  payload: ReturnType<typeof parsePayload>,
  sections: CopilotSection[]
) {
  if (!isUnreadableAssistantContent(content)) return { content, recovered: false };
  const finding = payload.investigation?.presentation?.finding?.trim();
  if (finding && !hasChinese(finding) && !isPlaceholderAnswer(finding)) return { content: finding, recovered: true };
  const facts = payload.investigation?.structured?.observedFacts
    ?.filter((item) => item.verified && item.text?.trim() && !hasChinese(item.text))
    .map((item) => item.text.trim()) || [];
  if (facts.length) return { content: facts.slice(0, 3).join(" "), recovered: true };
  const sectionFacts = sections.flatMap((section) => section.items || []).filter((item) => item?.trim() && !hasChinese(item));
  if (sectionFacts.length) return { content: sectionFacts.slice(0, 3).join(" "), recovered: true };
  return { content: "", recovered: false };
}

function isUnreadableAssistantContent(value: string) {
  return !value?.trim() || isPlaceholderAnswer(value);
}

function isPlaceholderAnswer(value: string) {
  return /could not translate.*saved response|investigation complete for|response is available in the structured findings|structured findings below|no campaign named campaign show\b/i.test(value);
}


function isKind(value: string | null): value is MessageRecord["kind"] {
  return value === "chat" || value === "metrics" || value === "investigation" || value === "proposal" || value === "diff" || value === "review";
}

function parsePayload(value: string | null): Pick<MessageRecord, "evidence" | "series" | "tools" | "steps" | "statusTrail" | "investigation" | "runtime"> {
  const parsed = parse<unknown>(value, []);
  if (Array.isArray(parsed)) {
    return { evidence: parsed as MessageRecord["evidence"], series: null, tools: [], steps: [], statusTrail: [], investigation: null, runtime: null };
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as {
      cites?: MessageRecord["evidence"];
      series?: TrendPoint[] | null;
      tools?: ToolName[];
      steps?: MessageRecord["steps"];
      statusTrail?: string[];
      investigation?: MessageRecord["investigation"];
      runtime?: InvestigationRuntimeTrace | null;
    };
    return {
      evidence: record.cites || (record as { evidence?: MessageRecord["evidence"] }).evidence || [],
      series: record.series || null,
      tools: record.tools || [],
      steps: record.steps || [],
      statusTrail: record.statusTrail || [],
      investigation: record.investigation || null,
      runtime: record.runtime || null,
    };
  }
  return { evidence: [], series: null, tools: [], steps: [], statusTrail: [], investigation: null, runtime: null };
}

function parse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

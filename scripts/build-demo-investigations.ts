import fs from "node:fs";
import path from "node:path";
import { getDb } from "../apps/web/lib/db";
import { getDatasetMeta } from "../apps/web/lib/analytics";
import { openConversation, renameConversation, sendMessage } from "../apps/web/lib/copilot/conversations";
import { investigateTurn } from "../apps/web/lib/copilot/investigate/run";
import { buildProductModel } from "../apps/web/lib/copilot/service";
import { DEMO_INVESTIGATIONS } from "../apps/web/lib/demo/investigation-specs";
import { resolveEvaluationDir } from "../apps/web/lib/paths";

const accountId = "criteo-demo";
const ownerId = "user";
const meta = getDatasetMeta();
if (!meta.ready || !meta.generatedAt || meta.schemaVersion !== 2) throw new Error("Processed dataset schema v2 is required before building demos.");
if (!meta.datasetVersion) throw new Error("A content-derived processed dataset version is required before building demos.");

const db = getDb();
const manifest: {
  datasetGeneratedAt: string;
  datasetVersion: string;
  datasetRows: number | null;
  metricContract: string;
  investigations: Array<Record<string, unknown>>;
} = {
  datasetGeneratedAt: meta.generatedAt,
  datasetVersion: meta.datasetVersion,
  datasetRows: meta.rowCount,
  metricContract: "conversion-linked click rows grouped by impression date; unique conversion_id counts remain audit-only",
  investigations: [],
};

for (const spec of DEMO_INVESTIGATIONS) {
  const model = buildProductModel({ accountId, windowId: spec.selectedWindow });
  const finding = spec.campaignId ? model.findings.find((item) => item.campaignId === spec.campaignId) || null : null;
  const validationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
  const validated: Array<{ answer: string; tools: string[] }> = [];
  for (const turn of spec.turns) {
    const result = await investigateTurn({ question: turn.userQuestion, accountId, windowId: spec.selectedWindow, campaignId: spec.campaignId, findingId: finding?.id || null, forceRuleMode: true, history: validationHistory });
    if (JSON.stringify(result.answer.tools) !== JSON.stringify(turn.requiredTools)) throw new Error(`${spec.id}/${turn.id}: tool plan mismatch (${result.answer.tools.join(", ")})`);
    for (const fact of turn.expectedFacts) if (!new RegExp(fact, "i").test(result.answer.answer)) throw new Error(`${spec.id}/${turn.id}: missing expected fact ${fact}`);
    for (const claim of turn.unsupportedClaims) if (new RegExp(claim, "i").test(result.answer.answer)) throw new Error(`${spec.id}/${turn.id}: unsupported claim ${claim}`);
    validationHistory.push({ role: "user", content: turn.userQuestion }, { role: "assistant", content: result.answer.answer });
    validated.push({ answer: result.answer.answer, tools: result.answer.tools });
  }

  const demoKey = `${spec.id}:${meta.datasetVersion}`;
  db.prepare(`UPDATE conversations SET status = 'archived' WHERE is_demo = 1 AND demo_key LIKE ? AND demo_key <> ?`).run(`${spec.id}:%`, demoKey);
  db.prepare(`UPDATE conversations SET status = 'archived' WHERE is_demo = 1 AND title = ? AND demo_key <> ?`).run(spec.title, demoKey);
  const conversation = openConversation({ ownerId, accountId, windowId: spec.selectedWindow, findingId: finding?.id || null, campaignId: spec.campaignId, contextType: spec.campaignId ? "investigation" : "account", forceNew: true, demoKey });
  renameConversation(conversation.id, ownerId, spec.title);
  for (const [index, turn] of spec.turns.entries()) {
    const messageKey = `demo:${spec.id}:${turn.id}:${meta.sourceSha256?.slice(0, 12) || "source"}`;
    const saved = await sendMessage(conversation.id, ownerId, turn.userQuestion, messageKey);
    if (saved.assistant.content !== validated[index].answer) {
      throw new Error(`${spec.id}/${turn.id}: persisted answer does not match the verified current-engine answer`);
    }
  }

  manifest.investigations.push({
    investigationId: conversation.id,
    demoKey,
    title: spec.title,
    resolvedScope: spec.campaignId || "project-selected-campaigns",
    selectedWindow: spec.selectedWindow,
    campaignId: spec.campaignId,
    turns: spec.turns.map((turn, index) => ({
      investigation_id: conversation.id,
      user_question: turn.userQuestion,
      resolved_scope: turn.resolvedScope,
      selected_window: spec.selectedWindow,
      required_metrics: turn.requiredMetrics,
      analysis_operation: turn.analysisOperation,
      expected_facts: turn.expectedFacts,
      expected_behavior: turn.expectedBehavior,
      unsupported_claims: turn.unsupportedClaims,
      expected_next_step: turn.expectedNextStep,
      actual_answer: validated[index].answer,
      actual_tools: validated[index].tools,
      fact_checks_passed: true,
    })),
  });
}

const output = path.join(resolveEvaluationDir(), "results", "demo-investigations-latest.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(manifest, null, 2));
console.log(`Built ${manifest.investigations.length} verified demo investigations for dataset ${meta.generatedAt}.`);
console.log(`Manifest: ${output}`);

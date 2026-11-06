import assert from "node:assert/strict";
import { EVAL_CASES } from "../apps/web/lib/eval/cases";
import { RESULT_PATH, writeEvaluationResult } from "../apps/web/lib/eval/read";
import { runEvaluation } from "../apps/web/lib/eval/runner";
import type { Ratio } from "../apps/web/lib/eval/types";

const result = await runEvaluation();
assert.equal(result.cases.length, EVAL_CASES.length);
assert.equal(result.dataset.syntheticUsedAsProductionAnalysis, false);
assert.equal(result.metrics.passRate.denominator, result.cases.length);
assert.ok(result.metrics.investigationLatency.sampleSize > 0);
assert.ok(result.runId, "Evaluation runs should have a stable run id.");
assert.ok(result.productVersion, "Evaluation runs should record the product version.");
for (const item of result.cases) {
  assert.ok(item.input.expectedBehavior.length > 0, `${item.id} should record its expected behavior.`);
  assert.ok(Array.isArray(item.input.history), `${item.id} should record its history context.`);
  assert.equal(typeof item.output.answer, "string", `${item.id} should record the generated answer.`);
  assert.equal(item.output.evaluator, "deterministic-code", `${item.id} should identify the independent code evaluator.`);
}
for (const item of [result.metrics.passRate, result.metrics.factualAccuracy, result.metrics.evidenceCoverage, result.metrics.unsupportedClaimRate, result.metrics.toolExecutionReliability, result.metrics.decisionPersistenceReliability]) {
  assertRatio(item);
}
if (result.baseline.status === "not_run") {
  assert.equal(result.baseline.summaryArm, null);
  assert.equal(result.baseline.investigationArm, null);
}
assert.deepEqual(result.failedCaseIds, result.cases.filter((item) => !item.pass).map((item) => item.id));

writeEvaluationResult(result);
const pass = result.metrics.passRate;
const facts = result.metrics.factualAccuracy;
const evidence = result.metrics.evidenceCoverage;
const claims = result.metrics.unsupportedClaimRate;
console.log(`cases ${pass.numerator}/${pass.denominator}`);
console.log(`facts ${facts.numerator}/${facts.denominator}`);
console.log(`evidence ${evidence.numerator}/${evidence.denominator}`);
console.log(`unsupported ${claims.numerator}/${claims.denominator}`);
console.log(`tools ${result.metrics.toolExecutionReliability.numerator}/${result.metrics.toolExecutionReliability.denominator}`);
console.log(`latency median ${result.metrics.investigationLatency.medianMs} ms n=${result.metrics.investigationLatency.sampleSize}`);
console.log(`persistence ${result.metrics.decisionPersistenceReliability.numerator}/${result.metrics.decisionPersistenceReliability.denominator}`);
console.log(`investigation arm ${result.investigationArm}`);
console.log(`baseline ${result.baseline.status}`);
console.log(`failed ${result.failedCaseIds.join(", ") || "none"}`);
console.log(`wrote ${RESULT_PATH}`);

function assertRatio(item: Ratio) {
  assert.ok(item.denominator > 0, item.definition);
  assert.ok(item.numerator >= 0 && item.numerator <= item.denominator);
}

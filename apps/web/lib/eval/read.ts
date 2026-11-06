import fs from "node:fs";
import path from "node:path";
import type { EvaluationResult } from "./types";
import { resolveEvaluationDir } from "../paths";

const EVAL_RESULTS_DIR = path.join(resolveEvaluationDir(), "results");
export const RESULT_PATH = path.join(EVAL_RESULTS_DIR, "latest.json");
export const RUNS_PATH = path.join(EVAL_RESULTS_DIR, "runs");

export function readEvaluationResult(): EvaluationResult | null {
  if (!fs.existsSync(RESULT_PATH)) return null;
  const parsed = JSON.parse(fs.readFileSync(RESULT_PATH, "utf8")) as EvaluationResult;
  if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.cases)) return null;
  return parsed;
}

export function writeEvaluationResult(result: EvaluationResult) {
  fs.mkdirSync(RUNS_PATH, { recursive: true });
  const payload = `${JSON.stringify(result, null, 2)}\n`;
  fs.writeFileSync(path.join(RUNS_PATH, `${result.runId}.json`), payload);
  fs.writeFileSync(RESULT_PATH, payload);
}

export function listEvaluationResults(limit = 8): EvaluationResult[] {
  if (!fs.existsSync(RUNS_PATH)) return [];
  return fs.readdirSync(RUNS_PATH)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit)
    .flatMap((name) => {
      try {
        const result = JSON.parse(fs.readFileSync(path.join(RUNS_PATH, name), "utf8")) as EvaluationResult;
        return result.schemaVersion === 2 ? [result] : [];
      } catch {
        return [];
      }
    });
}

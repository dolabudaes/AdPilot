export type CaseOrigin = "criteo" | "synthetic";

export type Ratio = {
  numerator: number;
  denominator: number;
  definition: string;
};

export type FactCheck = {
  id: string;
  ok: boolean;
  detail: string;
};

export type CaseResult = {
  id: string;
  title: string;
  theme: string;
  origin: CaseOrigin;
  pass: boolean;
  latencyMs: number | null;
  facts: { passed: number; total: number };
  evidence: { valid: number; required: number; included: boolean };
  unsupported: { hits: number; checks: number; included: boolean };
  tools: { reliable: number; attempted: number };
  failures: string[];
  syntheticIsolated: boolean;
  dimension: "factual" | "grounding" | "diagnostic" | "multi_turn" | "safety" | "reliability";
  input: {
    question: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    expectedBehavior: string;
    referenceFacts: string[];
  };
  output: {
    answer: string;
    evaluator: "deterministic-code";
    evaluation: "pass" | "fail";
  };
};

export type EvaluationResult = {
  schemaVersion: 2;
  runId: string;
  productVersion: string;
  generatedAt: string;
  runner: "rule-investigation" | "llm-investigation";
  investigationArm: "rule" | "llm";
  dataset: {
    cases: number;
    criteo: number;
    synthetic: number;
    syntheticUsedAsProductionAnalysis: false;
  };
  metrics: {
    passRate: Ratio;
    factualAccuracy: Ratio;
    evidenceCoverage: Ratio;
    unsupportedClaimRate: Ratio;
    toolExecutionReliability: Ratio;
    investigationLatency: {
      medianMs: number | null;
      sampleSize: number;
      definition: string;
    };
    decisionPersistenceReliability: Ratio;
  };
  baseline: {
    status: "not_run" | "completed";
    reason: string;
    model: string | null;
    temperature: number | null;
    summaryArm: Ratio | null;
    investigationArm: Ratio | null;
  };
  cases: CaseResult[];
  failedCaseIds: string[];
};

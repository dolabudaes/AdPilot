import type { CopilotSection } from "@/lib/copilot/answers";
import type { InvestigationResultPayload, InvestigationRuntimeTrace, InvestigationStep } from "./types";

type VisibleAnswer = {
  answer: string;
  evidence: Array<{ label: string; value: string; baseline?: string | null; absolute?: string | null; relative?: string | null; points?: string | null; id?: string }>;
  sections: CopilotSection[];
  investigation: InvestigationResultPayload | null;
  steps: InvestigationStep[];
  runtime: InvestigationRuntimeTrace | null;
};

/** Text surface used by evaluation factual checks — must include tool errors and step summaries. */
export function buildVisibleReport(answer: VisibleAnswer, note: string) {
  const evidence = answer.evidence.flatMap((item) => [item.label, item.value, item.baseline, item.absolute, item.relative, item.points, item.id]);
  const sections = answer.sections.flatMap((section) => section.items);
  const investigation = answer.investigation
    ? [...answer.investigation.found, ...answer.investigation.explanations, ...answer.investigation.cannotDetermine, ...answer.investigation.nextSteps]
    : [];
  const steps = answer.steps.map((step) => step.summary);
  const runtime = answer.runtime
    ? [
        answer.runtime.fallbackLabel,
        ...answer.runtime.toolSelectionErrors,
        ...answer.runtime.synthesisErrors,
        answer.runtime.toolSelection,
        answer.runtime.reportSynthesis,
      ]
    : [];
  return [answer.answer, note, ...steps, ...runtime, ...sections, ...investigation, ...evidence].filter(Boolean).join("\n");
}

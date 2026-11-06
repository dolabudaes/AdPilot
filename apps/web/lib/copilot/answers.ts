import { ACTION_LABEL, EVIDENCE_LABEL, FINDING_LABEL, formatChange, formatCount, formatRate, SEVERITY_LABEL, STATUS_LABEL } from "./labels";
import type { FindingView, ProductModel } from "./types";

export type AnswerKind = "chat" | "metrics" | "investigation" | "proposal" | "diff" | "review";
export type CopilotSection = { title: string; items: string[] };

export type CopilotAnswer = {
  answer: string;
  kind: AnswerKind;
  evidence: Array<{
    label: string;
    value: string;
    source: string;
    id?: string;
    baseline?: string | null;
    absolute?: string | null;
    relative?: string | null;
    points?: string | null;
    windowLabel?: string;
    compareLabel?: string | null;
    metric?: string;
  }>;
  uncertainty: string;
  revision: { actionType: "review" | "hold" | "decrease_priority"; reason: string; label: string } | null;
  sections: CopilotSection[];
  reviewReady: boolean;
};

const UNCERTAINTY =
  "Numbers come from deterministic calculations in the current window. Budget, bids, creatives, landing pages, and post-execution outcomes are not in the dataset.";

export function answerQuestion(model: ProductModel, question: string, findingId?: string | null): CopilotAnswer {
  const text = question.trim();
  const finding = model.findings.find((item) => item.id === findingId) || null;
  if (!model.ready) return pack(model.briefing.summary, "chat");
  if (!finding) return pack("Select a campaign issue first. Answers use that issue's window and metrics.", "chat");
  switch (intentOf(text)) {
    case "execute":
      return pack(
        "I cannot execute delivery changes. Approval, export, and external marking are separate steps; this conversation does not write to ad platforms.",
        "chat"
      );
    case "review":
      return reviewAnswer(finding);
    case "diff":
      return diffAnswer(finding);
    case "conservative":
      return conservativeAnswer(finding);
    case "missing":
      return missingAnswer(finding, model);
    case "evidence":
      return evidenceAnswer(finding);
    case "priority":
      return priorityAnswer(finding);
    case "hold":
      return holdAnswer(finding);
    case "pause":
      return pauseAnswer(finding);
    case "why":
      return whyAnswer(finding);
    default:
      return pack(`${finding.campaignName}: ${finding.interpretation}`, "chat", evidenceFrom(finding).slice(0, 2));
  }
}

function intentOf(text: string) {
  const q = text.toLowerCase();
  if (/执行|改预算|直接暂停|execute|change the budget/.test(q)) return "execute";
  if (/审批|审核|human review|prepare this|for review/.test(q)) return "review";
  if (/差异|差别|不同|original proposal|different from|对比原/.test(q)) return "diff";
  if (/保守|更稳|conservative|safer/.test(q)) return "conservative";
  if (/还缺|缺少|additional evidence|what .*evidence|do we need|不确定|uncertainty|核验/.test(q)) return "missing";
  if (/证据|依据|哪些数据|evidence|来源/.test(q)) return "evidence";
  if (/优先级|priority/.test(q)) return "priority";
  if (/不调整|不改|leave unchanged|维持|会怎样/.test(q)) return "hold";
  if (/暂停|pause/.test(q) && !/为什么|why/.test(q)) return "pause";
  if (/为什么|为何|why|decline|下降|转化/.test(q)) return "why";
  return "chat";
}

function whyAnswer(finding: FindingView): CopilotAnswer {
  const pattern = readPattern(finding);
  const confirmed = movedFacts(finding);
  return pack(
    pattern.clicksUp && pattern.conversionsDown
      ? `${finding.campaignName}: clicks rose while conversion-linked clicks and post-click conversion-link rate fell. That is what the comparison window shows—it is not yet a root cause.`
      : `${finding.campaignName} is flagged as ${FINDING_LABEL[finding.type]}. Below are metrics that actually moved in this comparison.`,
    "investigation",
    evidenceFrom(finding),
    null,
    null,
    [
      { title: "Confirmed", items: confirmed },
      { title: "Possible explanations", items: hypothesesFor(finding, pattern) },
      { title: "Not yet confirmed", items: gapsFor(pattern) },
      { title: "Next steps", items: checksFor(finding, pattern) },
      { title: "Actions to consider", items: [actionLine(finding)] },
    ]
  );
}

function missingAnswer(finding: FindingView, model: ProductModel): CopilotAnswer {
  const pattern = readPattern(finding);
  return pack(
    `Available fields cannot explain a root cause for ${finding.campaignName}. What is missing is data that could falsify the hypotheses below—not another metric summary.`,
    "investigation",
    [],
    model.missing.join(" "),
    null,
    [
      { title: "Not yet confirmed", items: [...gapsFor(pattern), ...model.missing] },
      { title: "Suggested checks", items: checksFor(finding, pattern) },
    ]
  );
}

function evidenceAnswer(finding: FindingView): CopilotAnswer {
  return pack(
    `These numbers come from ${finding.windowLabel}${finding.compareLabel ? ` compared with ${finding.compareLabel}` : ""}. Select a row to locate it in evidence.`,
    "metrics",
    evidenceFrom(finding)
  );
}

function priorityAnswer(finding: FindingView): CopilotAnswer {
  return pack(
    `${finding.campaignName} is ${SEVERITY_LABEL[finding.severity]} priority because magnitude and click sample both crossed thresholds—not because every decline enters the queue.`,
    "metrics",
    evidenceFrom(finding).filter(
      (item) => item.label === "Clicks" || item.label === "Post-click conversion-link rate" || item.label === "点击" || item.label === "点击后转化率"
    ),
    null,
    null,
    [
      {
        title: "Assessment",
        items: [
          `Type: ${FINDING_LABEL[finding.type]}`,
          `Clicks ${formatCount(finding.raw.clicks)}, comparison ${formatCount(finding.raw.previousClicks)}`,
          `Post-click conversion-link rate ${formatRate(finding.raw.cvr)}, change ${formatChange(finding.raw.cvrChangePct)}`,
          finding.recommendation ? EVIDENCE_LABEL[finding.recommendation.proposal.evidenceLevel] : "No proposal generated yet",
        ],
      },
    ]
  );
}

function conservativeAnswer(finding: FindingView): CopilotAnswer {
  const revision = conservativeRevision(finding);
  if (!revision) return pack("There is no recommendation that can be tightened further.", "chat");
  return pack(
    `A more conservative option is to change ${ACTION_LABEL[finding.recommendation!.proposal.actionType]} to ${ACTION_LABEL[revision.actionType]}. This is only a candidate; saving moves it to draft and does not auto-submit for review.`,
    "proposal",
    [],
    null,
    revision,
    [
      {
        title: "Tradeoffs",
        items: [
          "This candidate does not change delivery settings.",
          "It cannot estimate how many conversion-linked clicks might be spared because post-execution data is unavailable.",
        ],
      },
    ]
  );
}

function diffAnswer(finding: FindingView): CopilotAnswer {
  const current = finding.recommendation;
  if (!current) return pack("This issue has no proposal to compare yet.", "chat");
  const revision = conservativeRevision(finding);
  const original = ACTION_LABEL[current.original.actionType];
  const saved = ACTION_LABEL[current.proposal.actionType];
  const candidate = revision ? ACTION_LABEL[revision.actionType] : saved;
  return pack(
    current.userEdited
      ? `The saved proposal is ${saved}; the original rule suggestion was ${original}. Review status is still ${current.status}; this conversation did not change it.`
      : `The original rule suggestion was ${original}. With the conservative candidate, the action would become ${candidate}. Nothing is saved yet, so the formal proposal remains ${saved}.`,
    "diff",
    [],
    null,
    revision && !current.userEdited ? revision : null,
    [
      {
        title: "Comparison",
        items: [
          `Original suggestion: ${original}`,
          `Current formal proposal: ${saved}${current.userEdited ? " (edited)" : ""}`,
          `Conservative candidate: ${candidate}`,
          "The difference is action intensity, not metrics. Metrics were not recomputed.",
        ],
      },
    ]
  );
}

function reviewAnswer(finding: FindingView): CopilotAnswer {
  const proposal = finding.recommendation;
  if (!proposal) return pack("This issue has no recommendation ready to confirm.", "chat");
  const ready = proposal.status === "draft" && proposal.proposal.guardrail.passed;
  return pack(
    ready
      ? `You can confirm "${ACTION_LABEL[proposal.proposal.actionType]}." This is a review summary only; the recommendation stays a draft until you confirm it.`
      : `Current status is ${STATUS_LABEL[proposal.status]}. This conversation cannot confirm a recommendation for you.`,
    "review",
    evidenceFrom(finding).slice(0, 3),
    proposal.proposal.riskNote,
    null,
    [
      {
        title: "Review summary",
        items: [
          finding.interpretation,
          `Action: ${ACTION_LABEL[proposal.proposal.actionType]}`,
          proposal.proposal.riskNote,
          "Approval is not execution, and there is no platform write.",
        ],
      },
    ],
    ready
  );
}

function holdAnswer(finding: FindingView): CopilotAnswer {
  return pack(
    `You can leave ${finding.campaignName} unchanged. Observed differences remain, but there is no estimate of what holding would cost.`,
    "proposal",
    [],
    null,
    finding.recommendation
      ? {
          actionType: "hold",
          reason: `Continue monitoring ${finding.campaignName} without changing priority.`,
          label: "Save as continue monitoring",
        }
      : null
  );
}

function pauseAnswer(finding: FindingView): CopilotAnswer {
  const action = finding.recommendation?.proposal.actionType;
  if (action === "pause_candidate") {
    return pack(
      `${finding.campaignName} is flagged for review before pausing based on post-click conversion-link rate ${formatChange(finding.raw.cvrChangePct)} and ${formatCount(finding.raw.clicks)} clicks. This is not an executed pause.`,
      "proposal",
      evidenceFrom(finding).filter(
        (item) => item.label === "Clicks" || item.label === "Post-click conversion-link rate" || item.label === "点击" || item.label === "点击后转化率"
      ),
      null,
      {
        actionType: "review",
        reason: `Run manual review for ${finding.campaignName} instead of a pause candidate.`,
        label: "Change to manual review",
      }
    );
  }
  return pack(
    `${finding.campaignName} did not meet the threshold for review-before-pause. Current suggestion: ${action ? ACTION_LABEL[action] : "no action generated"}.`,
    "chat"
  );
}

function readPattern(finding: FindingView) {
  return {
    clicksUp: (finding.raw.clicksChangePct || 0) > 0,
    conversionsDown: (finding.raw.conversionDelta || 0) < 0,
    cvrDown: (finding.raw.cvrChangePct || 0) < 0,
    costUp: (finding.raw.costPerClickChangePct || 0) > 0,
  };
}

function hypothesesFor(finding: FindingView, pattern: ReturnType<typeof readPattern>) {
  if (finding.type === "cost_rise" || (pattern.costUp && !pattern.cvrDown)) {
    return [
      "Cost index per click rose, but that is not ad spend. Without budget and bid fields, do not describe this as a bid or budget increase.",
    ];
  }
  if (finding.type === "scale_opportunity") {
    return [
      "Post-click conversion-link rate beats its comparison window. That supports validating whether the improvement is sustained, not increasing budget, bids, or advertising-platform priority.",
    ];
  }
  if (finding.type === "attribution_anomaly") {
    return [
      "Attribution-link share shifted. That is an attribution-mix signal, not proof that conversion events themselves fell. Finer attribution paths are unavailable.",
    ];
  }
  if (pattern.clicksUp && pattern.conversionsDown) {
    return [
      "New clicks may not have produced matching conversion-linked clicks. Without audience or placement splits, traffic mix change cannot be confirmed.",
      "Conversion logging in the later window may be incomplete. Only conversion-linked click aggregates are available—missing events vs. missing records cannot be separated.",
      "Landing pages or creatives after the click may have changed. Those fields are not in this dataset and cannot be stated as confirmed causes.",
    ];
  }
  if (pattern.cvrDown) {
    return [
      "Post-click conversion-link rate trails its comparison while conversion-linked clicks also fell. Without breakdowns, the decline cannot be assigned to one traffic source.",
    ];
  }
  return [finding.hypothesis];
}

function gapsFor(pattern: ReturnType<typeof readPattern>) {
  const gaps = ["Budget, bids, and verified spend are unavailable—no budget or bid conclusions."];
  if (pattern.clicksUp) gaps.push("Without audience, placement, or creative splits, extra clicks cannot be sourced.");
  if (pattern.conversionsDown || pattern.cvrDown) {
    gaps.push("Without conversion detail or landing-page data, missing conversion-linked clicks cannot be split between not happening vs. not recorded.");
  }
  return gaps;
}

function checksFor(finding: FindingView, pattern: ReturnType<typeof readPattern>) {
  const checks = [
    `On the investigate page, check whether daily clicks and conversion-linked clicks for ${finding.campaignName} move in opposite directions on the same days.`,
  ];
  if (pattern.clicksUp && pattern.conversionsDown) {
    checks.push(
      "If audience or creative data becomes available, verify whether new clicks came from slices that historically converted worse. That check is not possible now."
    );
  }
  if (pattern.costUp) {
    checks.push("Keep cost index separate from verified spend. Only the index is available—it should not be rewritten as rising spend.");
  }
  checks.push("Sample and magnitude are enough to flag an issue, but not enough to name a single confirmed root cause.");
  return checks;
}

function actionLine(finding: FindingView) {
  if (!finding.recommendation) return "Sample or magnitude was insufficient—no candidate action was generated.";
  return `The rule candidate is ${ACTION_LABEL[finding.recommendation.proposal.actionType]}. It is evidence-bound—not a confirmed cause—and has not passed human review.`;
}

function conservativeRevision(finding: FindingView): CopilotAnswer["revision"] {
  const action = finding.recommendation?.proposal.actionType;
  if (!action) return null;
  const next = action === "pause_candidate" || action === "decrease_priority" || action === "increase_priority" ? "review" : "hold";
  if (next === action) return null;
  return {
    actionType: next,
    reason: `Use ${ACTION_LABEL[next]} for ${finding.campaignName} instead of ${ACTION_LABEL[action]}.`,
    label: `Save as ${ACTION_LABEL[next]}`,
  };
}

function movedFacts(finding: FindingView) {
  const rows = finding.evidence.filter(
    (item) => item.delta && item.delta !== "No comparison" && item.delta !== "没有对照" && item.delta !== "0.0%" && item.delta !== "+0.0%"
  );
  const source = rows.length ? rows : finding.evidence;
  return source.map((item) => {
    if (item.label === "Cost index" || item.label === "成本指数") {
      return `Cost index: current ${item.value}, comparison ${item.baseline || "—"}. ${item.delta || "—"} reflects cost index per click, not a ratio of these totals and not ad spend.`;
    }
    return `${item.label}: current ${item.value}, comparison ${item.baseline || "—"}, change ${item.delta || "—"}`;
  });
}

function pack(
  answer: string,
  kind: AnswerKind,
  evidence: CopilotAnswer["evidence"] = [],
  uncertainty: string | null = UNCERTAINTY,
  revision: CopilotAnswer["revision"] = null,
  sections: CopilotSection[] = [],
  reviewReady = false
): CopilotAnswer {
  return { answer, kind, evidence, uncertainty: uncertainty || UNCERTAINTY, revision, sections, reviewReady };
}

function evidenceFrom(finding: FindingView | null) {
  if (!finding) return [];
  return finding.evidence.slice(0, 4).map((item) => ({ label: item.label, value: item.value, source: item.source }));
}

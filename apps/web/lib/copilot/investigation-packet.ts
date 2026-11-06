import type { EvidenceItem, FindingType, Severity } from "./types";

export type PacketMessage = {
  role?: string;
  content?: string;
  tools?: string[];
  status?: string;
  reviewReady?: boolean;
};

export type InvestigationTrailStep = {
  id: string;
  label: string;
  tools: string[];
  conversationId: string | null;
  windowId: string | null;
  datasetVersion: string | null;
};

export type InvestigationPacket = {
  title: string;
  action: string;
  reason: string;
  verificationSteps: string[];
  trail: InvestigationTrailStep[];
  peer: string | null;
  priorityPeer: string | null;
  daily: boolean;
  compared: boolean;
  creativeChecked: boolean;
  reviewReady: boolean;
};

export type PacketContext = {
  campaignName: string;
  title?: string | null;
  findingType?: FindingType | null;
  severity?: Severity | null;
  evidence?: EvidenceItem[];
  conversationId?: string | null;
  windowId?: string | null;
  windowLabel?: string | null;
  datasetVersion?: string | null;
  actionType?: string | null;
};

export function compileInvestigationPacket(context: PacketContext, messages: PacketMessage[] = []): InvestigationPacket {
  const completed = messages.filter((item) => item.status !== "failed");
  const tools = completed.flatMap((item) => item.tools || []);
  const text = completed.map((item) => item.content || "").join("\n");
  const daily = tools.includes("analyze_daily_trend");
  const compared = tools.includes("compare_campaigns");
  const metricsReviewed = tools.includes("get_campaign_metrics") || completed.some((item) => item.role === "assistant" && item.content?.trim());
  const creativeChecked = completed.some((item) => /creative/i.test(item.content || "")) && /cannot be verified|no creative|not in this dataset/i.test(text);
  const reviewReady = completed.some((item) => item.reviewReady) || /create a (?:review )?(?:decision|recommendation)|human-review recommendation|turn .{0,80}into a (?:human[- ])?review/i.test(text);
  const peer = compared ? firstPeer(context.campaignName, text) : null;
  const priorityPeer = peer && /first human review|review first|highest-ranked|more severe|declined more/i.test(text) ? peer : null;
  const validationTask = isImprovement(context);
  const declineReview = isDecline(context);
  const action = actionHeadline(context, validationTask, declineReview, Boolean(priorityPeer) || (declineReview && context.severity === "high" && compared));
  const reason = rationale(context, { validationTask, declineReview, daily, compared, peer, priorityPeer, creativeChecked });
  const verificationSteps = verificationItems(context, { validationTask, declineReview, daily });
  const trail = trailSteps(context, { metricsReviewed, daily, compared, creativeChecked, reviewReady });
  return {
    title: action,
    action,
    reason,
    verificationSteps,
    trail,
    peer,
    priorityPeer,
    daily,
    compared,
    creativeChecked,
    reviewReady,
  };
}

function actionHeadline(
  context: PacketContext,
  validationTask: boolean,
  declineReview: boolean,
  prioritize: boolean
) {
  const name = context.campaignName;
  if (validationTask) return `Validate ${name}'s conversion-link improvement before scaling`;
  if (declineReview && prioritize) return `Prioritize ${name}: verify setup before any delivery change`;
  if (declineReview && context.severity === "high") return `Verify ${name} before changing delivery`;
  if (declineReview) return `Verify ${name}'s conversion-link decline before changing delivery`;
  if (context.findingType === "cost_rise") return `Review ${name}'s cost-index increase`;
  if (context.findingType === "weak_click_efficiency") return `Review ${name}'s weak click efficiency`;
  if (context.findingType === "attribution_anomaly") return `Review ${name}'s attribution change`;
  if (context.findingType === "data_gap") return `Review ${name}'s incomplete measurement`;
  return `Review ${name}`;
}

function rationale(
  context: PacketContext,
  trail: {
    validationTask: boolean;
    declineReview: boolean;
    daily: boolean;
    compared: boolean;
    peer: string | null;
    priorityPeer: string | null;
    creativeChecked: boolean;
  }
) {
  const name = context.campaignName;
  const rate = findEvidence(context.evidence || [], ["post-click conversion-link rate", "conversion-link rate", "点击后转化率", "点击后转化关联率", "post-click cvr"]);
  const clicks = findEvidence(context.evidence || [], ["clicks", "点击"]);
  const linked = findEvidence(context.evidence || [], ["conversion-linked clicks", "conversions", "转化关联点击", "转化"]);
  const rateDir = direction(rate);
  const clickDir = direction(clicks);
  const linkedDir = direction(linked);
  const sentences: string[] = [];

  if (trail.validationTask) {
    sentences.push("The conversion-link rate improved substantially, but this alone does not demonstrate that increasing delivery or budget would improve outcomes.");
  } else if (trail.declineReview) {
    if (clickDir === "up" && (rateDir === "down" || linkedDir === "down")) {
      sentences.push(`${name}'s conversion-link rate declined even as click volume increased, and conversion-linked clicks did not keep pace.`);
    } else if (rateDir === "down") {
      sentences.push("The conversion-link rate declined from the previous window.");
    } else {
      sentences.push("The saved conversion-link evidence supports a human review of this campaign.");
    }
    if (trail.creativeChecked) {
      sentences.push("A creative-change hypothesis was considered and could not be verified from this dataset.");
    } else {
      sentences.push(`Next: verify creative, landing-page, audience, budget, and tracking in the ad platform for ${windowPhrase(context)} before changing delivery.`);
    }
    if (trail.priorityPeer) {
      sentences.push(`A same-window comparison found ${name}'s decline more severe than ${trail.priorityPeer}'s, so it is the higher-priority case for investigation.`);
    } else if (trail.compared && trail.peer) {
      sentences.push(`A same-window comparison with ${trail.peer} was completed; it does not establish a shared cause.`);
    } else if (context.severity === "high") {
      sentences.push("This is a high-priority investigation signal, but the available data does not establish the underlying cause.");
    } else if (context.severity === "medium") {
      sentences.push("The movement meets the medium-priority review criteria. Further investigation is warranted before drawing conclusions about its cause.");
    }
  } else if (context.findingType === "cost_rise") {
    sentences.push("The cost index moved higher. Cost here is an index, not verified spend, so the next step is review rather than a bid change.");
  } else {
    sentences.push("The saved metrics support a human review. They do not identify a delivery change to make.");
  }

  if (trail.daily && sentences.length < 3 && !trail.validationTask && !trail.creativeChecked) {
    sentences.push("Daily observations were reviewed; the cause is still unverified.");
  } else if (sentences.length < 2) {
    sentences.push("The available data does not establish the underlying cause.");
  }

  return sentences.slice(0, 3).join(" ");
}

function verificationItems(
  context: PacketContext,
  trail: { validationTask: boolean; declineReview: boolean; daily: boolean }
) {
  const window = windowPhrase(context);
  const name = context.campaignName;
  const items: string[] = [];
  if (trail.validationTask) {
    items.push(`First confirm whether ${name}'s conversion-link improvement in ${window} holds across days.`);
    items.push("Then check creative, landing page, audience, budget, and bids in the advertising platform. Those fields are not in this snapshot.");
    items.push("Only after the improvement is verified outside this log should delivery or budget be considered.");
  } else if (trail.declineReview) {
    items.push(`First check whether ${name} had creative, landing-page, or audience changes in ${window}. Those fields are not in this snapshot.`);
    items.push("Then inspect budget, bids, and delivery structure for the same window.");
    items.push(trail.daily
      ? "Only after tracking, attribution-window, and measurement issues are ruled out, consider a delivery change."
      : "Check whether the conversion-link decline persists across days, then consider a delivery change only after measurement issues are ruled out.");
  } else {
    if (!trail.daily) items.push("Check whether the change persists across daily observations.");
    items.push("Review creative, audience, budget, and bid history in the advertising platform.");
    items.push("Do not change delivery until tracking and measurement questions are resolved.");
  }
  return unique(items).slice(0, 3);
}

function windowPhrase(context: PacketContext) {
  return context.windowLabel?.trim() || "this analysis window";
}

function trailSteps(
  context: PacketContext,
  flags: { metricsReviewed: boolean; daily: boolean; compared: boolean; creativeChecked: boolean; reviewReady: boolean }
) {
  const source = {
    conversationId: context.conversationId || null,
    windowId: context.windowId || null,
    datasetVersion: context.datasetVersion || null,
  };
  const steps: InvestigationTrailStep[] = [];
  if (flags.metricsReviewed) {
    steps.push({ id: "signal", label: "Initial signal reviewed", tools: ["get_campaign_metrics"], ...source });
  }
  if (flags.daily) {
    steps.push({ id: "daily", label: "Daily trend inspected", tools: ["analyze_daily_trend"], ...source });
  }
  if (flags.compared) {
    steps.push({ id: "compare", label: "Campaign comparison completed", tools: ["compare_campaigns"], ...source });
  }
  if (flags.creativeChecked) {
    steps.push({ id: "creative", label: "Creative-change hypothesis considered", tools: ["get_campaign_metrics"], ...source });
  }
  if (flags.reviewReady) {
    steps.push({ id: "recommend", label: "Review recommendation generated", tools: [], ...source });
  }
  return steps;
}

function firstPeer(campaignName: string, text: string) {
  const names = [...text.matchAll(/Campaign\s+[A-Z0-9]+/g)].map((item) => item[0]).filter((name) => name !== campaignName);
  return [...new Set(names)][0] || null;
}

function isImprovement(context: PacketContext) {
  return (
    context.findingType === "scale_opportunity" ||
    context.actionType === "increase_priority" ||
    /validate(?: observed)? conversion-link improvement|increase priority/i.test(`${context.title || ""}`)
  );
}

function isDecline(context: PacketContext) {
  return (
    context.findingType === "cvr_anomaly" ||
    context.findingType === "cost_rise" ||
    /conversion-link rate decline|conversion-efficiency decline|conversion efficiency decline|efficiency decline/i.test(`${context.title || ""}`)
  );
}

function findEvidence(evidence: EvidenceItem[], labels: string[]) {
  return evidence.find((item) => {
    const label = item.label.toLowerCase();
    return labels.some((needle) => label === needle || label.includes(needle));
  });
}

function direction(item: EvidenceItem | undefined) {
  if (!item) return null;
  const current = parseNumber(item.value);
  const previous = parseNumber(item.baseline);
  if (current == null || previous == null) {
    if (item.delta && /^-/.test(item.delta.trim())) return "down";
    if (item.delta && /^\+/.test(item.delta.trim())) return "up";
    return null;
  }
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "flat";
}

function parseNumber(value: string | null | undefined) {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function unique(items: string[]) {
  return items.filter((item, index) => items.indexOf(item) === index);
}

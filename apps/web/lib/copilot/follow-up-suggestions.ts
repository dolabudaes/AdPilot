type SuggestionMessage = {
  role: "user" | "assistant";
  content: string;
  tools?: string[];
  reviewReady?: boolean;
  actions?: Array<{ label: string; question?: string }>;
};

export type FollowUpOptions = {
  campaignName?: string | null;
  tools?: string[];
  reviewReady?: boolean;
  hasCreateCta?: boolean;
  canCompare?: boolean;
};

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function askedIntents(messages: SuggestionMessage[]) {
  return new Set(
    messages
      .filter((message) => message.role === "user")
      .map((message) => intent(message.content))
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
  );
}

function intent(value: string) {
  const normalized = normalize(value);
  if (/\b(daily|trend|days?|sustained|concentrated)\b/.test(normalized)) return "trend";
  if (/\b(compare|comparison|same pattern|another campaign|versus|vs|how did campaign)\b/.test(normalized)) return "comparison";
  if (/\b(creative|budget|cause|explain|hypothesis)\b/.test(normalized)) return "cause";
  if (/\b(review first|which campaign|prioriti[sz]e|summarize|established)\b/.test(normalized)) return "synthesize";
  if (/\b(verify|check|recommendation|decision draft)\b/.test(normalized)) return "next";
  if (/\b(why|high priority|what changed)\b/.test(normalized)) return "signal";
  return null;
}

export function buildFollowUpSuggestions(messages: SuggestionMessage[], options: FollowUpOptions = {}) {
  const asked = new Set(
    messages.filter((message) => message.role === "user").map((message) => normalize(message.content))
  );
  const usedIntents = askedIntents(messages);
  const tools = new Set([
    ...(options.tools || []),
    ...messages.flatMap((message) => message.tools || []),
  ]);
  const sawTrend = tools.has("analyze_daily_trend") || usedIntents.has("trend");
  const sawCompare = tools.has("compare_campaigns") || usedIntents.has("comparison");
  const sawCause = usedIntents.has("cause");
  const reviewReady = Boolean(options.reviewReady || messages.some((message) => message.reviewReady) || usedIntents.has("synthesize"));
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  const greeting = /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))[.!?\s]*$/.test((latestUser?.content || "").trim());
  const improved = /improv|increase|scale|budget/i.test(messages.map((item) => item.content).join("\n"));
  const canCompare = options.canCompare !== false;

  const candidates: string[] = [];
  if (greeting || !messages.some((item) => item.role === "user" && !/^(?:hi|hello|hey)/i.test(item.content.trim()))) {
    candidates.push("Which campaigns need attention in this window?", "What changed for this campaign?");
  } else if (reviewReady || options.hasCreateCta) {
    candidates.push("Summarize what we've established.", options.hasCreateCta ? "What should we verify externally?" : "Create a review recommendation.");
  } else if (sawCompare && sawCause) {
    candidates.push("Which campaign should be reviewed first?", "What should we verify externally?");
  } else if (sawCompare) {
    candidates.push("What could explain the decline?", "Which campaign should be reviewed first?");
  } else if (sawTrend) {
    if (canCompare) candidates.push("Does another flagged campaign show a similar pattern?");
    candidates.push(improved ? "What could explain the improvement?" : "What could explain the decline?");
  } else {
    candidates.push("Show me the daily trend.", "Compare with the previous window.");
  }

  const structured = ([...messages].reverse().find((message) => message.role === "assistant")?.actions || [])
    .map((action) => action.question?.trim() || "")
    .filter(Boolean);

  const combined = [...structured, ...candidates]
    .filter((item, index, values) => values.findIndex((candidate) => normalize(candidate) === normalize(item)) === index)
    .filter((item) => !asked.has(normalize(item)))
    .filter((item) => {
      const kind = intent(item);
      if (kind === "trend" && sawTrend) return false;
      if (kind === "comparison" && sawCompare) return false;
      if (kind && usedIntents.has(kind) && kind !== "next" && kind !== "synthesize") return false;
      if (!canCompare && kind === "comparison") return false;
      return true;
    });
  return combined.slice(0, 2);
}

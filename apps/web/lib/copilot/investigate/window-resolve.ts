export function resolveTurnWindow(
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }> | undefined,
  fallback: string
) {
  const fromQuestion = parseWindowMention(question);
  if (fromQuestion) return fromQuestion;
  for (const turn of [...(history || [])].reverse()) {
    if (turn.role !== "user") continue;
    const found = parseWindowMention(turn.content);
    if (found) return found;
  }
  return fallback;
}

export function parseWindowMention(text: string) {
  const compact = text.toLowerCase().replace(/\s+/g, " ");
  const match = compact.match(/\bd\s*(\d+)\s*[–\-]\s*d?\s*(\d+)\b/);
  if (match) return `d${match[1]}-d${match[2]}`;
  if (/\bearlier (analysis )?window\b|\bprevious 7[- ]day\b|\bprior 7[- ]day\b/.test(compact)) return "d18-d24";
  if (/\b(?:latest|recent) 7[- ]day\b|\brecent[_ ]7d\b/.test(compact) && /\bwindow\b/.test(compact)) return "recent_7d";
  return null;
}

export function isCompileQuestion(question: string) {
  return /compil(?:e|ed)|summarize (?:all |the )?(?:prior |previous )?(?:investigation )?evidence|create (?:a )?(?:review )?(?:decision(?: draft)?|recommendation)|turn .{0,80}into a (?:human[- ])?review|into one (?:human[- ])?review/i.test(
    question
  );
}

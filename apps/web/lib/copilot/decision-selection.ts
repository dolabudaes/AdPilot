export type SelectableDecision = {
  id: string;
  status: string;
  campaignId: string;
  windowId: string | null;
};

export type DecisionSelectionInput = {
  decisions: SelectableDecision[];
  status: string;
  selectedId?: string | null;
  campaignId?: string | null;
  filterWindow?: string | null;
  holdUntilRedirect?: boolean;
};

export type DecisionSelection = {
  visible: SelectableDecision[];
  selected: SelectableDecision | null;
  selectedId: string | null;
  needsRedirect: boolean;
};

export function filterDecisions<T extends SelectableDecision>(input: {
  decisions: T[];
  status: string;
  campaignId?: string | null;
  filterWindow?: string | null;
}): T[] {
  const status = input.status === "all" || !input.status ? "all" : input.status;
  let rows = status === "all" ? input.decisions : input.decisions.filter((item) => item.status === status);
  if (input.campaignId) rows = rows.filter((item) => item.campaignId === input.campaignId);
  if (input.filterWindow) rows = rows.filter((item) => item.windowId === input.filterWindow);
  return rows;
}

export function resolveDecisionSelection<T extends SelectableDecision>(input: {
  decisions: T[];
  status: string;
  selectedId?: string | null;
  campaignId?: string | null;
  filterWindow?: string | null;
  holdUntilRedirect?: boolean;
}): { visible: T[]; selected: T | null; selectedId: string | null; needsRedirect: boolean } {
  const visible = filterDecisions(input);
  const requested = input.selectedId || null;
  const inView = requested ? visible.find((item) => item.id === requested) || null : null;
  if (inView) {
    return { visible, selected: inView, selectedId: inView.id, needsRedirect: false };
  }
  if (!visible.length) {
    return { visible, selected: null, selectedId: null, needsRedirect: Boolean(requested) };
  }
  if (input.holdUntilRedirect && requested) {
    return { visible, selected: null, selectedId: requested, needsRedirect: true };
  }
  const next = visible[0];
  return {
    visible,
    selected: next,
    selectedId: next.id,
    needsRedirect: requested !== next.id,
  };
}

export function decisionStatusCounts<T extends SelectableDecision>(input: {
  decisions: T[];
  campaignId?: string | null;
  filterWindow?: string | null;
}) {
  const scoped = filterDecisions({ ...input, status: "all" });
  return {
    all: scoped.length,
    draft: scoped.filter((item) => item.status === "draft").length,
    confirmed: scoped.filter((item) => item.status === "confirmed").length,
    dismissed: scoped.filter((item) => item.status === "dismissed").length,
  };
}

export function decisionsHref(input: {
  status?: string;
  id?: string | null;
  campaignId?: string | null;
  window?: string | null;
  history?: string | null;
}) {
  const params = new URLSearchParams();
  const status = input.status || "all";
  if (status !== "all") params.set("status", status);
  else params.set("status", "all");
  if (input.id) params.set("id", input.id);
  if (input.campaignId) params.set("campaign", input.campaignId);
  if (input.window) params.set("window", input.window);
  if (input.history) params.set("history", input.history);
  const query = params.toString();
  return query ? `/decisions?${query}` : "/decisions";
}

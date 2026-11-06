import type { ActionType } from "@/lib/analytics/types";
import { ACTION_LABEL } from "./labels";

const ACTIONS = Object.entries(ACTION_LABEL) as Array<[ActionType, string]>;

export function proposalConsistencyIssue(actionType: ActionType, reason: string): string | null {
  const rationale = reason.trim().toLowerCase();
  if (!rationale) return null;
  const conflicting = ACTIONS.find(([candidate, label]) => candidate !== actionType && rationale.includes(label.toLowerCase()));
  if (!conflicting) return null;
  return `The rationale still describes “${conflicting[1]}”. Update it to match “${ACTION_LABEL[actionType]}” before submitting.`;
}

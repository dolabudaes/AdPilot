const enabled = process.env.NODE_ENV !== "production";

export function debugDecision(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>
) {
  if (!enabled) return;
  const compact = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
  console.debug(`[adpilot:decision] ${event}`, compact);
}

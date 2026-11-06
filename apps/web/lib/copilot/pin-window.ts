type Search = Record<string, string | string[] | undefined>;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;
const SCHEMA_VERSION = /^schema-\d+:([a-f0-9]{32,})$/i;

function contentKey(value: string) {
  const schema = SCHEMA_VERSION.exec(value);
  if (schema) return schema[1].toLowerCase();
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  return null;
}

export function snapshotsMatch(recorded: string | null | undefined, live: Array<string | null | undefined>) {
  if (!recorded) return true;
  const versions = live.filter((item): item is string => Boolean(item));
  if (!versions.length) return true;
  if (versions.includes(recorded)) return true;
  if (versions.some((item) => recorded.includes(item) || item.includes(recorded))) return true;
  const recordedKey = contentKey(recorded);
  if (recordedKey && versions.some((item) => contentKey(item) === recordedKey || item.toLowerCase().includes(recordedKey))) {
    return true;
  }
  // Import clocks are not the processed-file identity. Timestamp-only history stays usable
  // until a schema hash is stored and that hash actually changes.
  if (ISO_TIMESTAMP.test(recorded) && !recordedKey) return true;
  return false;
}

export function pinnedSearch(searchParams: Search | undefined, patch: Record<string, string | null>) {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams || {})) {
    if (typeof value === "string" && value) next.set(key, value);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!value) next.delete(key);
    else next.set(key, value);
  }
  return next.toString();
}

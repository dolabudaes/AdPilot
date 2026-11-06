import fs from "node:fs";
import path from "node:path";

let loaded = false;

/** Load repo-root `.env.local` once (setdefault: existing process.env wins). */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;

  let dir = process.cwd();
  let envPath: string | null = null;
  for (;;) {
    const candidate = path.join(dir, ".env.local");
    if (fs.existsSync(candidate)) {
      envPath = candidate;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!envPath) return;

  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadRootEnv();

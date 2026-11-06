import "@/lib/load-root-env";
import fs from "node:fs";
import path from "node:path";

let cachedRepoRoot: string | null = null;

function readPackageJson(dir: string): { workspaces?: unknown } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { workspaces?: unknown };
  } catch {
    return null;
  }
}

function looksLikeRepoRoot(dir: string): boolean {
  // Require monorepo markers — do not treat apps/web/data/adpilot.db as the repo root.
  const pkg = readPackageJson(dir);
  if (pkg && Array.isArray(pkg.workspaces)) return true;
  return (
    fs.existsSync(path.join(dir, "apps", "web", "package.json")) &&
    fs.existsSync(path.join(dir, "apps", "api"))
  );
}

/** Monorepo root (contains `data/` and workspace `package.json`). */
export function resolveRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;

  const fromEnv = process.env.ADPILOT_ROOT || process.env.ADPILOT_REPO_ROOT;
  if (fromEnv) {
    cachedRepoRoot = path.resolve(fromEnv);
    return cachedRepoRoot;
  }

  let dir = process.cwd();
  for (;;) {
    if (looksLikeRepoRoot(dir)) {
      cachedRepoRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedRepoRoot = process.cwd();
  return cachedRepoRoot;
}

function resolveFromRepoRoot(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(resolveRepoRoot(), value);
}

export function resolveDataDir(): string {
  const fromEnv = process.env.ADPILOT_DATA_DIR?.trim();
  if (fromEnv) return resolveFromRepoRoot(fromEnv);
  return path.join(resolveRepoRoot(), "data");
}

export function resolveSqlitePath(): string {
  const fromEnv = process.env.SQLITE_PATH?.trim();
  if (fromEnv) return resolveFromRepoRoot(fromEnv);
  return path.join(resolveDataDir(), "adpilot.db");
}

export function resolveEvaluationDir(): string {
  return path.join(resolveRepoRoot(), "evaluation");
}

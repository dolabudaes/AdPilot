import { getCurrentActor, listActors, type Actor } from "@/lib/auth";
import { getDatasetMeta } from "@/lib/analytics";
import { listAnalysisRuns } from "@/lib/dataStore";
import { getDataHealth } from "./health";
import { countPendingDecisions } from "./store";
import { windowOptions } from "./windows";

export type ShellNotice = { id: string; tone: "warning" | "info"; title: string; href: string };

export type ShellModel = {
  actor: Actor;
  actors: Actor[];
  accounts: Array<{ id: string; name: string; demo: boolean }>;
  windows: Array<{ id: string; label: string }>;
  freshness: { serviceOnline: boolean; filesReady: boolean; generatedAt: string | null; stale: boolean; label: string };
  notices: ShellNotice[];
  pendingReviews: number;
};

export function getShellModel(): ShellModel {
  try {
    const actor = getCurrentActor();
    const actors = listActors();
    const health = getDataHealth();
    const meta = getDatasetMeta();
    const pending = health.serviceOnline ? countPendingDecisions() : 0;
    const failed = listAnalysisRuns(10).filter((run) => run.status === "failed");
    const notices: ShellNotice[] = [];
    if (!health.filesReady) notices.push({ id: "files", tone: "warning", title: "Analytics files are unavailable", href: "/data-sources" });
    else if (health.stale) notices.push({ id: "stale", tone: "warning", title: `Snapshot is ${health.ageDays} days old`, href: "/data-sources" });
    if (pending) notices.push({ id: "pending", tone: "info", title: `${pending} draft recommendation${pending === 1 ? "" : "s"} waiting for confirmation`, href: "/decisions?status=draft" });
    if (failed.length) notices.push({ id: "failed", tone: "warning", title: `${failed.length} recent job${failed.length === 1 ? "" : "s"} failed`, href: "/data-sources" });
    const generated = health.generatedAt ? new Date(health.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Unavailable";
    return {
      actor,
      actors,
      accounts: health.filesReady || health.sourceConnected ? [{ id: "criteo-demo", name: "Criteo log snapshot", demo: true }] : [],
      windows: windowOptions(meta),
      freshness: {
        serviceOnline: true,
        filesReady: health.filesReady,
        generatedAt: health.generatedAt,
        stale: health.stale,
        label: health.filesReady ? `Imported ${generated}` : "Analytics files unavailable",
      },
      notices,
      pendingReviews: pending,
    };
  } catch {
    return {
      actor: { id: "user", name: "User", role: "user", title: "Reviews investigations and confirms or dismisses AI recommendations" },
      actors: [],
      accounts: [],
      windows: [],
      freshness: { serviceOnline: false, filesReady: false, generatedAt: null, stale: false, label: "Service unavailable" },
      notices: [{ id: "down", tone: "warning", title: "Local data service is not ready", href: "/data-sources" }],
      pendingReviews: 0,
    };
  }
}

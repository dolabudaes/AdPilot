import { redirect } from "next/navigation";
import { getDatasetMeta } from "@/lib/analytics";
import { loadInvestigation } from "@/lib/copilot/load-investigation";
import { pinnedSearch } from "@/lib/copilot/pin-window";
import { listStrategyVersions } from "@/lib/copilot/strategy-versions";
import { windowOptions } from "@/lib/copilot/windows";
import { WorkspaceScreen } from "./screen";

export const dynamic = "force-dynamic";

export default function WorkspacePage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const data = loadInvestigation(searchParams);
  const requestedWindow = typeof searchParams?.window === "string" ? searchParams.window : "";
  if (data.pinnedWindowId && requestedWindow !== data.pinnedWindowId) {
    redirect(`/workspace?${pinnedSearch(searchParams, { window: data.pinnedWindowId })}`);
  }
  const versions = data.findingId ? listStrategyVersions(data.findingId) : [];
  const windows = windowOptions(getDatasetMeta());
  return (
    <WorkspaceScreen
      {...data}
      initialFindingId={data.findingId}
      initialCampaignId={data.campaignId}
      initialView={data.view}
      versions={versions}
      windowOptions={windows}
    />
  );
}

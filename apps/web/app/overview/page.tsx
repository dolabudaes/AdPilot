import { getCurrentActor } from "@/lib/auth";
import { buildProductModel } from "@/lib/copilot/service";
import { OverviewScreen } from "./screen";

export const dynamic = "force-dynamic";

export default function OverviewPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const actor = getCurrentActor();
  const account = typeof searchParams?.account === "string" ? searchParams.account : null;
  const windowId = typeof searchParams?.window === "string" ? searchParams.window : null;
  const model = buildProductModel({ accountId: account, windowId });
  return <OverviewScreen model={model} role={actor.role} />;
}

import { getCurrentActor } from "@/lib/auth";
import { listConversations } from "@/lib/copilot/conversations";
import { buildProductModel, listDecisions } from "@/lib/copilot/service";
import { CampaignsScreen } from "./screen";

export const dynamic = "force-dynamic";

export default function CampaignsPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const actor = getCurrentActor();
  const account = typeof searchParams?.account === "string" ? searchParams.account : null;
  const windowId = typeof searchParams?.window === "string" ? searchParams.window : null;
  const campaign = typeof searchParams?.campaign === "string" ? searchParams.campaign : null;
  const model = buildProductModel({ accountId: account, windowId });
  const conversations = model.account.id ? listConversations(actor.id, model.account.id) : [];
  const decisions = listDecisions("all");
  return <CampaignsScreen model={model} role={actor.role} initialCampaignId={campaign} conversations={conversations} decisions={decisions} />;
}

import { issueTitleForFinding } from "./issue-titles";
import type { FindingView, ProductModel } from "./types";
import { formatWindowRange } from "./windows";

export type InvestigationStarter = { label: string; question: string; campaignId: string | null };

export function investigationStartersFor(
  model: ProductModel,
  campaignId?: string | null
): InvestigationStarter[] {
  const finding =
    (campaignId && model.findings.find((item) => item.campaignId === campaignId)) ||
    model.findings.find((item) => item.campaignId === campaignId) ||
    null;
  const campaign = campaignId ? model.campaigns.find((item) => item.id === campaignId) : null;
  const name = finding?.campaignName || campaign?.name || null;
  const windowText = formatWindowRange(finding || model.window) || model.window?.label || "this window";

  if (name === "Campaign R") return campaignRStarters(name, windowText);
  if (name === "Campaign Q") return campaignQStarters(name, windowText);
  if (name && finding) return genericCampaignStarters(name, windowText, finding);

  return accountStarters(model);
}

function campaignRStarters(name: string, windowText: string): InvestigationStarter[] {
  return [
    {
      campaignId: name,
      label: `Why is ${name} flagged as high priority?`,
      question: `Why is ${name} flagged as high priority in ${windowText}? Distinguish the observed conversion-link change from unverified causes.`,
    },
    {
      campaignId: name,
      label: `Was ${name}'s decline sustained across the window?`,
      question: `Was ${name}'s conversion-link decline sustained across ${windowText}, or concentrated on a few days?`,
    },
    {
      campaignId: name,
      label: "How did Campaign D perform in the same window?",
      question: `How did Campaign D perform in ${windowText}? Compare verified conversion-link evidence without assuming a shared cause.`,
    },
  ];
}

function campaignQStarters(name: string, windowText: string): InvestigationStarter[] {
  return [
    {
      campaignId: name,
      label: `Why did ${name} decline?`,
      question: `Why did ${name} decline in ${windowText}? Separate the observed conversion-link change from unverified causes.`,
    },
    {
      campaignId: name,
      label: "Re-check the earlier D18–D24 window",
      question: `I meant the earlier D18–D24 window. Please re-check ${name} there and explain what actually happened.`,
    },
    {
      campaignId: name,
      label: `Should we increase ${name}'s budget?`,
      question: `Should we increase ${name}'s budget now based on the verified conversion-link evidence?`,
    },
  ];
}

function genericCampaignStarters(name: string, windowText: string, finding: FindingView): InvestigationStarter[] {
  const issue = issueTitleForFinding(finding).toLowerCase();
  return [
    {
      campaignId: finding.campaignId,
      label: `What changed for ${name}?`,
      question: `What verified metrics changed for ${name} in ${windowText}, and what remains unverified?`,
    },
    {
      campaignId: finding.campaignId,
      label: `Was the ${issue} sustained?`,
      question: `Was ${name}'s ${issue} in ${windowText} sustained across the days, or concentrated on a few dates?`,
    },
    {
      campaignId: finding.campaignId,
      label: `What should we verify next for ${name}?`,
      question: `What should a human verify next for ${name} before any delivery change?`,
    },
  ];
}

function accountStarters(model: ProductModel): InvestigationStarter[] {
  const top = model.findings.slice(0, 2);
  return [
    ...top.map((item) => ({
      campaignId: item.campaignId,
      label: `${item.campaignName}: ${issueTitleForFinding(item)}`,
      question:
        item.type === "scale_opportunity"
          ? `Which verified metrics support ${item.campaignName}'s positive efficiency signal, and what evidence is still missing before any delivery change?`
          : `Why is ${item.campaignName} flagged in this window, and what should we verify next?`,
    })),
    {
      campaignId: null,
      label: "Compare the campaigns needing attention",
      question: "Which campaigns need attention in this snapshot, and how do their verified signals differ?",
    },
  ];
}

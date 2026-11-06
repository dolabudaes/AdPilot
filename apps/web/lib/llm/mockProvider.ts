import { extractJson, LLMProvider } from "./provider";

const toLower = (s: string) => s.toLowerCase();

function has(word: string, text: string) {
  return toLower(text).includes(word);
}

export class MockLLMProvider implements LLMProvider {
  async generateStructured<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const avoidsClickWaste =
      has("不希望为了点击", userPrompt) ||
      has("不想为了点击", userPrompt) ||
      has("不要为了点击", userPrompt) ||
      has("浪费投放", userPrompt);
    const wantsClicks =
      !avoidsClickWaste &&
      (has("点击", userPrompt) || has("click", userPrompt) || has("流量", userPrompt) || has("traffic", userPrompt) || has("曝光", userPrompt));
    const acceptsConversionDecline =
      has("可以接受转化", userPrompt) || has("接受转化效率", userPrompt) || has("转化效率略微下降", userPrompt);
    const wantsConversion =
      !acceptsConversionDecline &&
      (has("转化", userPrompt) || has("conversion", userPrompt) || has("有效", userPrompt) || has("cvr", userPrompt));
    const wantsCost =
      !acceptsConversionDecline && (has("成本", userPrompt) || has("浪费", userPrompt) || has("低效", userPrompt) || has("效率", userPrompt));
    const wantsRisk = has("风险", userPrompt) || has("恶化", userPrompt) || has("最近", userPrompt) || has("明显下降", userPrompt);
    const primaryGoal = wantsConversion
      ? "effective_conversion"
      : wantsRisk
        ? "risk_control"
        : wantsClicks
        ? "traffic_growth"
        : wantsCost && !wantsConversion
          ? "cost_efficiency"
          : "other";
    const secondaryGoals = [
      wantsConversion ? "Improve effective conversions" : "",
      wantsClicks ? "Grow clicks or traffic" : "",
      wantsCost ? "Control low-quality clicks and wasted cost" : "",
      wantsRisk ? "Prioritize recently declining campaigns" : "",
    ].filter(Boolean);

    const payload = {
      primaryGoal,
      secondaryGoals,
      preferences: {
        prioritizeConversion: wantsConversion,
        prioritizeClicks: wantsClicks,
        prioritizeAttributedConversion: wantsConversion || has("归因", userPrompt),
        prioritizeCostEfficiency: wantsCost || wantsConversion,
        prioritizeRecentDecline: wantsRisk,
        prioritizeRiskControl: wantsRisk || has("不能", userPrompt) || has("不希望", userPrompt),
      },
      constraints: [
        has("不希望", userPrompt) || has("不能", userPrompt) ? "Avoid strong actions unrelated to the goal" : "",
        wantsCost ? "Focus on low-quality clicks and wasted cost" : "",
      ].filter(Boolean),
      rawInput: userPrompt,
    };

    return extractJson(JSON.stringify(payload)) as T;
  }
}

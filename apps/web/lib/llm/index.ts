import "@/lib/load-root-env";
import { MockLLMProvider } from "./mockProvider";
import { OpenAICompatibleProvider } from "./openAICompatibleProvider";
import { LLMProvider } from "./provider";
import { getSettings } from "../dataStore";

export function getLLMProviderFromEnv(): LLMProvider {
  const settings = getSettings();
  const provider = process.env.LLM_PROVIDER ?? settings?.llm_provider ?? "mock";
  const model = process.env.LLM_MODEL ?? settings?.llm_model ?? "gpt-4o-mini";
  const baseUrl = process.env.LLM_BASE_URL ?? settings?.llm_base_url ?? "https://api.openai.com/v1";
  const apiKey = process.env.LLM_API_KEY ?? settings?.llm_api_key ?? "";

  if (provider === "openai-compatible") {
    return new OpenAICompatibleProvider(
      baseUrl,
      apiKey,
      model
    );
  }
  return new MockLLMProvider();
}

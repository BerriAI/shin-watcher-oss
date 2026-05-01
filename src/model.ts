import type { Model } from "@mariozechner/pi-ai";
import { config } from "./config.js";

/**
 * Build a Model<'openai-completions'> that points at the user's LiteLLM proxy.
 * Every LLM call from every agent goes through this Model, so it shows up in
 * the litellm dashboard and is routed by whatever model_list the proxy has.
 *
 * Cost numbers here are approximate and only used by pi-ai for local cost
 * estimation telemetry. The real billing happens in litellm.
 */
export function buildLiteLlmModel(): Model<"openai-completions"> {
  return {
    id: config.litellm.modelId,
    name: `${config.litellm.modelId} (via LiteLLM)`,
    api: "openai-completions",
    provider: "litellm",
    baseUrl: config.litellm.baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    compat: {
      supportsStore: false,
    },
  };
}

/** API key resolver passed to pi-agent-core. Always returns the litellm key. */
export function getLiteLlmApiKey(): string {
  return config.litellm.apiKey;
}

import type { Model } from "@mariozechner/pi-ai";
import { config } from "./config.js";

/**
 * Build a Model<'anthropic-messages'> that points at the user's LiteLLM proxy.
 *
 * Why Anthropic API format (not OpenAI Completions):
 *   - Native Claude thinking blocks (thinkingLevel="high" → real `thinking.budget_tokens`)
 *   - Native prompt caching via cache_control breakpoints
 *   - Cleaner tool semantics (no JSON-string hack for tool args)
 *   - All of the above survive the LiteLLM passthrough on /v1/messages
 *
 * Wiring:
 *   - The Anthropic SDK that pi-ai uses appends `/v1/messages` to model.baseUrl,
 *     so set baseUrl to the LiteLLM root (no /v1 suffix).
 *   - apiKey becomes the `x-api-key` header, which LiteLLM accepts as a virtual key.
 *   - provider: "anthropic" picks the standard auth path (not Cloudflare/Copilot/OAuth).
 *
 * The cost numbers are local-telemetry only — actual billing happens in LiteLLM.
 */
export function buildLiteLlmModel(): Model<"anthropic-messages"> {
  return {
    id: config.litellm.modelId,
    name: `${config.litellm.modelId} (via LiteLLM)`,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: config.litellm.baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
}

/** API key resolver passed to pi-agent-core. Always returns the LiteLLM key. */
export function getLiteLlmApiKey(): string {
  return config.litellm.apiKey;
}

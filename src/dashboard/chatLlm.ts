import { config } from "../config.js";

/**
 * Lightweight chat completion for the dashboard (no tools).
 * Uses LiteLLM’s Anthropic-compatible `/v1/messages` endpoint.
 */
export async function chatWithLlm(
  userAssistantMessages: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  const system = [
    "You are a concise, friendly assistant for shin-watcher — a local agent that reproduces and triages bugs on the BerriAI/litellm GitHub repo.",
    "Answer questions normally. To run a full reproduction (browser + curl + screenshots), the user should paste a GitHub issue URL or a bare issue number like #12345.",
    "Keep replies short unless the user asks for detail.",
  ].join(" ");

  const messages = userAssistantMessages.map((m) => ({
    role: m.role,
    content: [{ type: "text", text: m.content }],
  }));

  const url = `${config.litellm.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.litellm.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.litellm.modelId,
      max_tokens: 2048,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const blocks = data.content ?? [];
  return blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n")
    .trim() || "(no reply)";
}

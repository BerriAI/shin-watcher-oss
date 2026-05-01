import { config } from "../config.js";

export interface DashboardChatResult {
  /** Visible assistant text for the UI */
  reply: string;
  /** If set, a repro run should be started in the background */
  repro: {
    issueNumber?: number;
    pickNextEligible: boolean;
  } | null;
}

type AnthropicContentBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown> | string;
};

const REPRO_TOOL = {
  name: "start_issue_reproduction",
  description:
    "Starts the full autonomous shin-watcher reproduction pipeline for BerriAI/litellm: local proxy, Playwright UI steps, curl proofs, screenshots, and (when enabled) GitHub comment/PR. Expensive — only when the user clearly wants hands-on issue reproduction, not for casual questions.",
  input_schema: {
    type: "object",
    properties: {
      issue_number: {
        type: "integer",
        description:
          "GitHub issue number on BerriAI/litellm if the user named one or you parsed it from a URL.",
      },
      pick_next_eligible: {
        type: "boolean",
        description:
          "True only if the user wants the system to pick the next eligible open bug (e.g. 'next', 'queue').",
      },
    },
    required: [] as string[],
  },
};

const CHAT_SYSTEM = [
  "You are the shin-watcher chat assistant for the BerriAI/litellm GitHub repository.",
  "",
  "Help the user in plain language: answer questions, explain concepts, brainstorm.",
  "",
  "You may call the tool `start_issue_reproduction` ONLY when the user clearly wants to **run** the autonomous repro agent (browser + curl + screenshots on their machine). Examples:",
  "  • “Reproduce #26987” / an issue URL to litellm",
  "  • “Start a repro on issue 12345”",
  "  • “Pick the next open bug and reproduce it”",
  "",
  "Do **not** call the tool for: greetings, generic LiteLLM questions, or architecture discussion unless they explicitly ask you to start reproduction.",
  "",
  "If you call the tool, your text reply should briefly confirm what is starting.",
  "If the user pastes a GitHub issue URL, parse the issue number into `issue_number`.",
].join("\n");

function messagesPayload(userAssistantMessages: { role: "user" | "assistant"; content: string }[]) {
  return userAssistantMessages.map((m) => ({
    role: m.role,
    content: [{ type: "text", text: m.content }],
  }));
}

function litellmMessagesBody(
  userAssistantMessages: { role: "user" | "assistant"; content: string }[],
  stream: boolean
) {
  return {
    model: config.litellm.modelId,
    max_tokens: 2048,
    system: CHAT_SYSTEM,
    messages: messagesPayload(userAssistantMessages),
    tools: [REPRO_TOOL],
    stream,
  };
}

/**
 * One chat turn: model may reply in natural language and/or call
 * `start_issue_reproduction`. Uses LiteLLM Anthropic-compatible `/v1/messages`.
 */
export async function dashboardChatTurn(
  userAssistantMessages: { role: "user" | "assistant"; content: string }[]
): Promise<DashboardChatResult> {
  const url = `${config.litellm.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.litellm.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(litellmMessagesBody(userAssistantMessages, false)),
  });

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${raw.slice(0, 500)}`);
  }

  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`LLM returned non-JSON: ${raw.slice(0, 300)}`);
  }

  const blocks = extractContentBlocks(data);

  let reply = blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n")
    .trim();

  const repro = extractReproFromBlocks(blocks);

  if (!reply) {
    reply =
      repro == null
        ? "(no reply)"
        : repro.issueNumber != null
          ? `Starting reproduction for **#${repro.issueNumber}**.`
          : "Starting reproduction on the **next eligible** issue.";
  }

  return { reply, repro };
}

/**
 * Streaming turn: streams text deltas via `onDelta`, then resolves the same result shape
 * as `dashboardChatTurn` (including tool / repro extraction from the final stream).
 */
export async function dashboardChatTurnStream(
  userAssistantMessages: { role: "user" | "assistant"; content: string }[],
  onDelta: (chunk: string) => void,
  options?: { signal?: AbortSignal }
): Promise<DashboardChatResult> {
  const url = `${config.litellm.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.litellm.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(litellmMessagesBody(userAssistantMessages, true)),
    signal: options?.signal,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${raw.slice(0, 500)}`);
  }
  if (!res.body) {
    throw new Error("LLM returned no response body");
  }

  const openAiParts: string[] = [];
  const blockKind = new Map<number, "text" | "tool_use">();
  const toolNameByIndex = new Map<number, string>();
  const fragments = new Map<number, string[]>();

  const append = (index: number, s: string) => {
    const arr = fragments.get(index) ?? [];
    arr.push(s);
    fragments.set(index, arr);
  };

  let sseBuf = "";
  const dec = new TextDecoder();
  const reader = res.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = sseBuf.indexOf("\n\n")) !== -1) {
        const block = sseBuf.slice(0, sep);
        sseBuf = sseBuf.slice(sep + 2);
        const obj = parseSseDataBlock(block);
        if (!obj || typeof obj !== "object") continue;
        const o = obj as Record<string, unknown>;

        const choices = o["choices"];
        if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
          const delta = (choices[0] as Record<string, unknown>)["delta"] as
            | Record<string, unknown>
            | undefined;
          const content = delta?.["content"];
          if (typeof content === "string" && content.length) {
            openAiParts.push(content);
            onDelta(content);
          }
          continue;
        }

        const t = o["type"];
        if (t === "content_block_start") {
          const idx = o["index"];
          const cb = o["content_block"] as Record<string, unknown> | undefined;
          const ctype = cb?.["type"];
          if (typeof idx === "number") {
            if (ctype === "tool_use") {
              blockKind.set(idx, "tool_use");
              const n = cb?.["name"];
              if (typeof n === "string") toolNameByIndex.set(idx, n);
            } else {
              blockKind.set(idx, "text");
            }
            if (!fragments.has(idx)) fragments.set(idx, []);
          }
          continue;
        }

        if (t === "content_block_delta") {
          const idx = o["index"];
          const delta = o["delta"] as Record<string, unknown> | undefined;
          if (typeof idx !== "number" || !delta) continue;
          const dt = delta["type"];
          if (dt === "text_delta") {
            const text = delta["text"];
            if (typeof text === "string" && text.length) {
              append(idx, text);
              onDelta(text);
            }
          } else if (dt === "input_json_delta") {
            const pj = delta["partial_json"];
            if (typeof pj === "string" && pj.length) append(idx, pj);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const blocks = buildBlocksFromStreamState(blockKind, toolNameByIndex, fragments);
  let reply = blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n")
    .trim();

  if (!reply && openAiParts.length) {
    reply = openAiParts.join("");
  }

  const repro = extractReproFromBlocks(blocks);

  if (!reply) {
    reply =
      repro == null
        ? "(no reply)"
        : repro.issueNumber != null
          ? `Starting reproduction for **#${repro.issueNumber}**.`
          : "Starting reproduction on the **next eligible** issue.";
  }

  return { reply, repro };
}

function parseSseDataBlock(block: string): unknown | null {
  const lines = block.split("\n");
  let data = "";
  for (const line of lines) {
    if (line.startsWith("data:")) {
      data += line.slice(5).trimStart();
    }
  }
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function buildBlocksFromStreamState(
  blockKind: Map<number, "text" | "tool_use">,
  toolNameByIndex: Map<number, string>,
  fragments: Map<number, string[]>
): AnthropicContentBlock[] {
  const indices = [...blockKind.keys()].sort((a, b) => a - b);
  const blocks: AnthropicContentBlock[] = [];
  for (const idx of indices) {
    const kind = blockKind.get(idx);
    const parts = (fragments.get(idx) ?? []).join("");
    if (kind === "text") {
      blocks.push({ type: "text", text: parts });
    } else if (kind === "tool_use") {
      const name = toolNameByIndex.get(idx) ?? "";
      let input: Record<string, unknown> | string = {};
      if (parts) {
        try {
          input = JSON.parse(parts) as Record<string, unknown>;
        } catch {
          input = {};
        }
      }
      blocks.push({ type: "tool_use", name, input });
    }
  }
  return blocks;
}

function extractReproFromBlocks(blocks: AnthropicContentBlock[]): DashboardChatResult["repro"] {
  let repro: DashboardChatResult["repro"] = null;
  for (const b of blocks) {
    if (b.type !== "tool_use" || b.name !== "start_issue_reproduction") continue;
    let inputObj: Record<string, unknown> = {};
    if (typeof b.input === "string") {
      try {
        inputObj = JSON.parse(b.input) as Record<string, unknown>;
      } catch {
        inputObj = {};
      }
    } else if (b.input && typeof b.input === "object") {
      inputObj = b.input as Record<string, unknown>;
    }

    const issueNumber = coerceIssueNumber(inputObj.issue_number);
    const pickNext = inputObj.pick_next_eligible === true;

    if (issueNumber != null) {
      repro = { issueNumber, pickNextEligible: false };
    } else if (pickNext) {
      repro = { pickNextEligible: true };
    }
  }
  return repro;
}

/** LiteLLM usually mirrors Anthropic `content[]`; normalize a few variants. */
function extractContentBlocks(data: unknown): AnthropicContentBlock[] {
  if (!data || typeof data !== "object") return [];
  const o = data as Record<string, unknown>;

  const fromArr = (v: unknown): AnthropicContentBlock[] | null => {
    if (!Array.isArray(v)) return null;
    return v as AnthropicContentBlock[];
  };

  let c = fromArr(o.content);
  if (c) return c;

  const inner = o.data;
  if (inner && typeof inner === "object") {
    c = fromArr((inner as Record<string, unknown>).content);
    if (c) return c;
  }

  const choices = o.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const msg = (choices[0] as Record<string, unknown>).message as
      | Record<string, unknown>
      | undefined;
    const content = msg?.content;
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (Array.isArray(content)) return content as AnthropicContentBlock[];
  }

  return [];
}

function coerceIssueNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const m = v.match(/(?:issues\/|^#?)(\d+)/);
    if (m) return parseInt(m[1] as string, 10);
    const n = parseInt(v.replace(/^#/, "").trim(), 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

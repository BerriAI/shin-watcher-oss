import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { awaitSessionAgent, SessionManager } from "../dashboard/session.js";
import type { ReportPayload } from "../tools/writeReport.js";

export interface RunRootChatOptions {
  sessionId: string;
  message: string;
  /**
   * Optional override for what gets recorded as the Langfuse trace `input`.
   * Use this when `message` has been augmented with transport-specific
   * context (e.g. Slack wraps the user message with thread context and
   * a "[Context: triggered from Slack...]" preamble) and you want the
   * trace to show just the raw human text.
   */
  traceInput?: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void | Promise<void>;
  onReproStart?: (replySoFar: string) => void | Promise<void>;
  onDone?: (reply: string, args: { reproStarted: boolean }) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  /** Called when the agent calls write_report — fires before onDone. */
  onReport?: (payload: ReportPayload) => void | Promise<void>;
}

/**
 * Shared transport-independent entry point for talking to the root agent.
 * Web SSE, Slack, and future chat surfaces should call this rather than
 * duplicating SessionManager/Agent event wiring.
 *
 * Each turn is wrapped in a single Langfuse trace named `chat-turn`:
 *   input    = the human message
 *   output   = the agent's accumulated text reply
 *   sessionId = the issue identifier — extracted eagerly from the user's
 *               message ("Reproduce #1234", a GitHub issue URL, etc.) or
 *               from the agent's "This is issue #XXX" Turn-1 declaration
 *               (per BerriAI/shin-watcher-oss#2). Falls back to the chat
 *               session id when no issue identifier is present.
 *
 * No nested LLM/tool spans are created — the user only wants to see the
 * human side and the agent side at the trace level.
 */
export async function runRootChat(opts: RunRootChatOptions): Promise<void> {
  const session = SessionManager.getOrCreate(opts.sessionId);
  session.lastActivityAt = Date.now();
  const agent = await awaitSessionAgent(session, 120_000);

  let replyAcc = "";
  let reproStarted = false;
  let forwarding = true;

  agent.subscribe((event: AgentEvent) => {
    if (!forwarding) return;
    const ev = event as Record<string, unknown>;

    if (ev["type"] === "message_update") {
      const ae = ev["assistantMessageEvent"] as Record<string, unknown> | undefined;
      if (ae?.["type"] === "text_delta" && typeof ae["delta"] === "string") {
        replyAcc += ae["delta"];
        void opts.onDelta?.(ae["delta"]);
      }
    }

    if (ev["type"] === "tool_call" && ev["name"] === "begin_repro_run" && !reproStarted) {
      reproStarted = true;
      void opts.onReproStart?.(replyAcc);
    }

    if (ev["type"] === "tool_call" && ev["name"] === "write_report") {
      const input = ev["input"] as ReportPayload | undefined;
      if (input) void opts.onReport?.(input);
    }
  });

  // What the human actually wrote (Slack/etc transports may augment
  // `message` with extra context before passing it to the agent).
  const humanInput = opts.traceInput ?? opts.message;

  // Resolve the Langfuse sessionId BEFORE creating the trace, in priority order:
  //   1. session.issueId (set on a previous turn — Turn 2+)
  //   2. issue # extracted from this user message ("Reproduce #1234", URL, etc.)
  //   3. opts.sessionId (chat/thread id — covers free-form Turn 1)
  const detectedFromInput = extractIssueId(humanInput);
  if (detectedFromInput && !session.issueId) {
    session.issueId = detectedFromInput;
  }
  const langfuseSessionId = session.issueId ?? opts.sessionId;

  await propagateAttributes({ sessionId: langfuseSessionId }, async () => {
    await startActiveObservation("chat-turn", async (span) => {
      span.update({ input: humanInput });

      try {
        await (agent as unknown as {
          prompt: (msg: string, opts?: { signal?: AbortSignal }) => Promise<void>;
        }).prompt(opts.message, opts.signal ? { signal: opts.signal } : undefined);

        // Late-detect from the agent's reply (covers cases where the user
        // pasted a free-form issue and the issue # only surfaced in the
        // agent's "This is issue #XXX" declaration on Turn 1).
        if (!session.issueId) {
          const detected = extractIssueId(replyAcc);
          if (detected) session.issueId = detected;
        }

        span.update({ output: replyAcc || "(no reply)" });
        await opts.onDone?.(replyAcc || "(no reply)", { reproStarted });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        span.update({
          output: `(error) ${err.message}`,
          level: "ERROR",
        });
        await opts.onError?.(err);
      } finally {
        forwarding = false;
      }
    });
  });
}

/**
 * Extract a Langfuse-friendly session identifier from a chat message or
 * agent reply. Recognised patterns:
 *
 *   "Reproduce #1234"                            → "issue-1234"
 *   "Reproduce issue #1234" / "issue 1234"       → "issue-1234"
 *   "github.com/BerriAI/litellm/issues/1234"     → "issue-1234"
 *   "This is issue #1234"                        → "issue-1234"
 *   "This is a pasted issue: <title>"            → "pasted-<slug>"
 *
 * Returns null when no identifier can be extracted.
 */
function extractIssueId(text: string): string | null {
  const urlMatch = text.match(/github\.com\/[^\s\/]+\/[^\s\/]+\/issues\/(\d+)/i);
  if (urlMatch) return `issue-${urlMatch[1]}`;

  const issueMatch = text.match(/issue\s*#?\s*(\d+)/i);
  if (issueMatch) return `issue-${issueMatch[1]}`;

  const hashMatch = text.match(/(?:^|\s)#(\d+)\b/);
  if (hashMatch) return `issue-${hashMatch[1]}`;

  const pastedMatch = text.match(/this is a pasted issue:?\s*([^\n]+)/i);
  if (pastedMatch) {
    const slug = pastedMatch[1]!
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return `pasted-${slug || "issue"}`;
  }

  return null;
}

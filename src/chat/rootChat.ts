import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { LangfuseOtelSpanAttributes } from "@langfuse/core";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { config } from "../config.js";
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
  /**
   * Explicit Langfuse session id supplied by the transport (e.g. Slack
   * mints one per thread, deterministic from `channel:threadTs`). When
   * provided this takes priority over every other heuristic and disables
   * late detection from the agent's reply — Slack/web transports control
   * grouping themselves rather than relying on the agent declaring it.
   */
  langfuseSessionId?: string;
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
 *   input    = the human message (raw, via traceInput when transports wrap it)
 *   output   = the agent's accumulated text reply
 *   sessionId = a stable id derived from:
 *               1. session.issueId (already set on a previous turn)
 *               2. the user's message (issue # / GitHub URL)
 *               3. the agent's "Session: <id>" Turn-1 declaration —
 *                  applied LATE via a direct OTEL `session.id` attribute
 *                  on the active span so Turn 1 itself lands in the right
 *                  Langfuse session even for free-form (non-issue) chats.
 *               4. opts.sessionId fallback (Slack thread id, etc.)
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
  // Set when the agent calls write_report so the heartbeat stops nudging
  // the agent toward its terminal tool after it has already been called.
  let writeReportFired = false;

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
      writeReportFired = true;
      const input = ev["input"] as ReportPayload | undefined;
      if (input) void opts.onReport?.(input);
    }
  });

  const humanInput = opts.traceInput ?? opts.message;

  // Resolution priority for the Langfuse sessionId:
  //   1. opts.langfuseSessionId — explicit, transport-supplied (Slack mints
  //      one per thread). Wins outright; we don't second-guess the caller
  //      and we skip late detection from the agent's reply.
  //   2. session.issueId — set on a previous turn of THIS chat, so all
  //      turns of the conversation share one session.
  //   3. issue # extracted from this user message (URL, "#1234", etc.).
  //   4. opts.sessionId — chat/thread id fallback.
  if (opts.langfuseSessionId) {
    session.issueId = opts.langfuseSessionId;
  } else {
    const eagerFromInput = extractSessionId(humanInput);
    if (eagerFromInput && !session.issueId) session.issueId = eagerFromInput;
  }
  const provisionalSessionId = session.issueId ?? opts.sessionId;

  await propagateAttributes({ sessionId: provisionalSessionId }, async () => {
    await startActiveObservation("chat-turn", async (span) => {
      span.otelSpan.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
        provisionalSessionId
      );
      span.update({ input: humanInput });

      // Periodic heartbeat: every CHAT_HEARTBEAT_INTERVAL_SEC seconds we
      // inject a HEARTBEAT user message into the running agent via
      // agent.steer(). steer queues the message to land cleanly between
      // assistant turns so it never interrupts an in-flight tool call or
      // LLM stream. This keeps the agent moving and ensures every Slack
      // turn closes the loop instead of stalling silently. The existing
      // 8-min hardTimeout in src/slack/bolt.ts remains the outer safety
      // net for the truly-wedged case.
      let elapsedSec = 0;
      const heartbeat = config.heartbeat.enabled
        ? setInterval(() => {
            if (writeReportFired) return;
            elapsedSec += config.heartbeat.intervalSec;
            try {
              (agent as unknown as {
                steer: (m: { role: "user"; content: string; timestamp: number }) => void;
              }).steer({
                role: "user",
                content:
                  `HEARTBEAT (${elapsedSec}s elapsed). Keep making progress on the user's request. ` +
                  `If you're done or have enough evidence, call write_report now. ` +
                  `Otherwise emit a one-line public PROGRESS update describing your next action and continue.`,
                timestamp: Date.now(),
              });
            } catch (e) {
              console.warn(`[chat:heartbeat] steer failed: ${(e as Error).message}`);
            }
          }, config.heartbeat.intervalSec * 1000)
        : null;
      heartbeat?.unref();

      try {
        await (agent as unknown as {
          prompt: (msg: string, opts?: { signal?: AbortSignal }) => Promise<void>;
        }).prompt(opts.message, opts.signal ? { signal: opts.signal } : undefined);

        // Only attempt late-detection when the transport did NOT supply
        // an explicit sessionId. Catches issue numbers the agent surfaces
        // for the first time on Turn 1 of CLI / web SSE chats.
        if (!opts.langfuseSessionId) {
          const detectedFromReply = extractSessionId(replyAcc);
          if (detectedFromReply && detectedFromReply !== session.issueId) {
            session.issueId = detectedFromReply;
            span.otelSpan.setAttribute(
              LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
              detectedFromReply
            );
          }
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
        if (heartbeat) clearInterval(heartbeat);
        forwarding = false;
      }
    });
  });
}

/**
 * Extract a Langfuse-friendly session identifier from a chat message or
 * agent reply. Patterns are checked in priority order; first match wins.
 *
 * PRIMARY (the convention enforced by the root system prompt — every
 * Turn-1 reply must start with this format):
 *
 *   "Session: snowflake-mcp-oauth-redirect-uri"  → "snowflake-mcp-oauth-redirect-uri"
 *   "Session: issue-26987"                       → "issue-26987"
 *   "Session: pasted-streaming-timeout"          → "pasted-streaming-timeout"
 *
 * LEGACY / from user input (kept as fallbacks so older traces, repro
 * commands, and bare GitHub URLs still produce a sensible session id):
 *
 *   "github.com/BerriAI/litellm/issues/1234"     → "issue-1234"
 *   "Reproduce issue #1234" / "issue 1234"       → "issue-1234"
 *   "Reproduce #1234"                            → "issue-1234"
 *   "This is issue #1234"                        → "issue-1234"
 *   "This is a pasted issue: <title>"            → "pasted-<slug>"
 *
 * Returns null when no identifier can be extracted.
 */
function extractSessionId(text: string): string | null {
  // Primary: explicit "Session: <slug>" line. Anchored to a line start so
  // we don't accidentally match the word "session" inside prose.
  const sessionLine = text.match(
    /(?:^|\n)\s*session:\s*([a-z0-9][a-z0-9-]{1,79}[a-z0-9])\s*(?:\n|$)/i
  );
  if (sessionLine) return sessionLine[1]!.toLowerCase();

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

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { awaitSessionAgent, SessionManager } from "../dashboard/session.js";

export interface RunRootChatOptions {
  sessionId: string;
  message: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void | Promise<void>;
  onReproStart?: (replySoFar: string) => void | Promise<void>;
  onDone?: (reply: string, args: { reproStarted: boolean }) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}

/**
 * Shared transport-independent entry point for talking to the root agent.
 * Web SSE, Slack, and future chat surfaces should call this rather than
 * duplicating SessionManager/Agent event wiring.
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
  });

  try {
    await (agent as unknown as {
      prompt: (msg: string, opts?: { signal?: AbortSignal }) => Promise<void>;
    }).prompt(opts.message, opts.signal ? { signal: opts.signal } : undefined);
    await opts.onDone?.(replyAcc || "(no reply)", { reproStarted });
  } catch (e) {
    await opts.onError?.(e instanceof Error ? e : new Error(String(e)));
  } finally {
    forwarding = false;
  }
}

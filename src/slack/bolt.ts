import { App } from "@slack/bolt";
import crypto from "node:crypto";
import fs from "node:fs";
import { config } from "../config.js";
import { runRootChat } from "../chat/rootChat.js";
import { State, type SlackTask } from "../state.js";
import { type ReportPayload, renderReportMarkdown } from "../tools/writeReport.js";

/**
 * Deterministic Langfuse session id for a Slack conversation.
 *
 * Hashing `${channel}:${threadTs}` gives us:
 *   • the SAME id for every reply in a thread (so all turns land in one
 *     Langfuse session without any persistence on our side),
 *   • a fresh id when the user starts a new top-level message,
 *   • a stable, copy-pasteable, human-readable handle the user can drop
 *     into Langfuse search.
 *
 * Format: `chat-<8 hex chars>` — short enough to fit nicely in a Slack
 * placeholder, long enough to be unique in practice.
 */
function deriveLangfuseSessionId(channelId: string, threadTs: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${channelId}:${threadTs}`)
    .digest("hex")
    .slice(0, 8);
  return `chat-${hash}`;
}

type SlackEventCommon = {
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  subtype?: string;
  bot_id?: string;
};

let started = false;
const seenEventIds = new Set<string>();
const seenMessageKeys = new Set<string>();

export async function startSlackBolt(): Promise<void> {
  if (started) return;
  if (!config.slack.useBolt) return;
  if (!config.slack.botToken || !config.slack.appToken) {
    console.warn(
      "[slack-bolt] disabled: set SLACK_BOT_TOKEN + SLACK_APP_TOKEN to enable Socket Mode"
    );
    return;
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    processBeforeResponse: true,
  });

  // Single durable State instance shared by every Slack handler in this
  // process. WAL mode means concurrent reads/writes are safe.
  const state = new State(config.paths.stateDb);

  // Boot-time recovery: surface every Slack message that was in flight
  // when the previous process died, so the user knows we lost it and can
  // resend. Runs once per startSlackBolt() call.
  await recoverOrphanedSlackTasks(app, state);

  // Global poller: every 30s, scan the DB for tasks that are 'running'
  // but whose updated_at hasn't moved in a while. Posts a heartbeat to
  // Slack so the user always knows we're still alive.
  startSlackTaskPoller(app, state);

  const runFromEvent = async (args: {
    source: "app_mention" | "message";  
    eventId?: string;
    event: SlackEventCommon;
    /** Enriched message (with thread context) — sent to the agent as the prompt. */
    message: string;
    /** Raw human-typed text — recorded as the Langfuse trace `input`. */
    rawMessage: string;
    kind: "direct" | "channel";
    post: (text: string, threadTs?: string) => Promise<{ ts: string }>;
    update: (ts: string, text: string, threadTs?: string) => Promise<void>;
    uploadFile: (filePath: string, caption: string, threadTs?: string) => Promise<void>;
  }): Promise<void> => {
    const event = args.event;
    const teamId = "socket";
    const threadTs = event.thread_ts ?? event.ts ?? String(Date.now() / 1000);
    const sessionId =
      args.kind === "direct"
        ? `slack:direct:${teamId}:${event.channel ?? "unknown"}:${event.user ?? "unknown"}`
        : `slack:channel:${teamId}:${event.channel ?? "unknown"}:thread:${threadTs}`;

    // Mint a deterministic Langfuse session id for this conversation —
    // same hash for every reply in the thread, fresh hash for new top-
    // level messages. Set BEFORE we post the placeholder so the user
    // sees the id they can use to look the trace up in Langfuse.
    const langfuseSessionId = deriveLangfuseSessionId(
      event.channel ?? "unknown",
      threadTs
    );

    // Persist the incoming task BEFORE any async work begins. If the
    // process dies between now and onDone, the row stays 'running' and is
    // surfaced on the next boot via recoverOrphanedSlackTasks.
    const taskId = state.recordSlackTask({
      channel: event.channel ?? "unknown",
      threadTs,
      messageTs: event.ts ?? String(Date.now() / 1000),
      kind: args.kind,
      rawText: args.rawMessage,
      enrichedMessage: args.message,
      sessionId,
      langfuseSessionId,
    });

    const sessionHeader = `_Session: \`${langfuseSessionId}\`_\n\n`;
    const placeholderText =
      args.kind === "direct"
        ? `${sessionHeader}:hourglass_flowing_sand: Looking into this now — I'll keep this DM as the session context.`
        : `${sessionHeader}:hourglass_flowing_sand: Looking into this now — I'll use this Slack thread as the session context.`;
    const { ts: placeholderTs } = await args.post(
      placeholderText,
      args.kind === "direct" ? undefined : threadTs
    );
    console.log(
      `[slack:post] placeholder ts=${placeholderTs} session=${sessionId} langfuse=${langfuseSessionId} taskId=${taskId}`
    );

    // Flip the row to 'running' and stamp the placeholder so the poller
    // / recovery path can edit it later.
    state.markSlackTaskRunning(taskId, placeholderTs);

    /**
     * Edit the placeholder in place AND keep the `_Session: <id>_`
     * header pinned at the top so the user can always see/copy the
     * session id no matter how the body changes (heartbeat, deltas,
     * score card, error).
     */
    const updateWithHeader = (text: string): Promise<void> =>
      args.update(
        placeholderTs,
        sessionHeader + text,
        args.kind === "direct" ? undefined : threadTs
      );

    let accumulated = "";
    let lastUpdateAt = 0;
    let finished = false;
    let lastActivityAt = Date.now();

    // Capture report payload + start Gist creation eagerly when write_report fires
    let reportPayload: ReportPayload | null = null;
    let gistPromise: Promise<string | null> | null = null;

    // Heartbeat edits the existing placeholder instead of posting new messages
    const heartbeat = setInterval(() => {
      if (finished) return;
      if (Date.now() - lastActivityAt < 30_000) return;
      lastActivityAt = Date.now();
      const heartbeatText =
        "_Working on this now (one-shot mode). I will post only the final PR result in this thread._";
      console.log(`[slack:post] heartbeat update ts=${placeholderTs}`);
      void updateWithHeader(heartbeatText);
    }, 15_000);
    heartbeat.unref();

    const abortController = new AbortController();
    const hardTimeout = setTimeout(() => {
      if (finished) return;
      abortController.abort();
    }, 8 * 60 * 1000);
    hardTimeout.unref();

    await runRootChat({
      sessionId,
      message: injectSlackContext(args.message, args.kind),
      // Langfuse trace shows just the raw human message — the wrapped
      // prompt with thread context is what the agent sees, but it's
      // noisy in the UI.
      traceInput: args.rawMessage,
      // Use the deterministic Slack-minted session id so every turn of
      // this thread groups together in Langfuse, regardless of what
      // the agent writes.
      langfuseSessionId,
      signal: abortController.signal,
      onReport: (payload) => {
        reportPayload = payload;
        console.log(`[slack:agent] write_report verdict=${payload.verdict} difficulty=${payload.difficulty}`);
        // Kick off Gist creation eagerly — it resolves before onDone fires
        gistPromise = createGist(
          `ShinBuilder report — verdict ${payload.verdict}/5`,
          renderReportMarkdown(payload)
        ).catch((e) => {
          console.warn(`[slack:post] gist creation failed: ${e}`);
          return null;
        });
      },
      onDelta: async (delta) => {
        accumulated += delta;
        lastActivityAt = Date.now();
        // One-shot PR mode: suppress planning/progress deltas from user-visible thread.
        // Keep only periodic heartbeat and final PR card.
        const now = Date.now();
        if (accumulated.trim() && now - lastUpdateAt > 10_000) {
          lastUpdateAt = now;
          // Bump the DB row's updated_at so the global poller can tell
          // this task is making real progress vs. genuinely stalled.
          state.bumpSlackTaskActivity(taskId);
          console.log(
            `[slack:agent] delta buffered chars=${accumulated.length} ts=${placeholderTs}`
          );
        }
      },
      onReproStart: async (replySoFar) => {
        lastActivityAt = Date.now();
        state.bumpSlackTaskActivity(taskId);
        console.log(
          `[slack:agent] repro_start chars=${replySoFar.length} ts=${placeholderTs}`
        );
        await updateWithHeader(
          "_Repro started (one-shot mode). I will post the final PR URL + proof once complete._"
        );
      },
      onDone: async (reply) => {
        finished = true;
        // Wait for Gist if it was started
        const gistUrl = gistPromise ? await gistPromise : null;
        console.log(`[slack:agent] done chars=${reply.length} gist=${gistUrl ?? "none"} ts=${placeholderTs}`);

        if (reportPayload) {
          // Upload the first "before" screenshot if available
          const beforeShot = reportPayload.screenshots.find((s) => s.kind === "before" || s.kind === "gif");
          if (beforeShot) {
            await args.uploadFile(beforeShot.path, beforeShot.caption, args.kind === "direct" ? undefined : threadTs);
          }
          // One-shot requirement: PR by default, with a single escape hatch for
          // truly unactionable requests.
          if (!reportPayload.pr_url && !reportPayload.no_action_reason) {
            await updateWithHeader(
              "❌ One-shot mode requires a draft PR URL unless `no_action_reason` is explicitly set for a truly unactionable request. Marking as failed."
            );
            state.markSlackTaskFailed(taskId, "missing pr_url in final report");
            return;
          }
          // Update placeholder with structured score card
          await updateWithHeader(buildScoreCard(reportPayload, gistUrl));
        } else {
          await updateWithHeader(
            "❌ One-shot mode requires a structured report with PR URL. Marking this run as failed."
          );
          state.markSlackTaskFailed(taskId, "missing report payload");
          return;
        }
        state.markSlackTaskDone(taskId);
      },
      onError: async (error) => {
        finished = true;
        const isAbort = error.name === "AbortError";
        console.log(`[slack:agent] error name=${error.name} msg=${error.message.slice(0, 120)}`);
        await updateWithHeader(
          isAbort
            ? "This run took too long and timed out. Please resend with a tighter scope (or issue URL), and I'll retry."
            : `Sorry, I hit an error: ${truncateSlackText(error.message, 1_500)}`
        );
        state.markSlackTaskFailed(taskId, error.message);
      },
    }).catch((e) => {
      // Last-resort safety net: if runRootChat itself throws synchronously
      // and onError doesn't fire, we still need to mark the row so the
      // poller doesn't think it's stuck forever.
      const msg = (e as Error).message ?? String(e);
      console.error(`[slack:agent] runRootChat threw outside onError: ${msg}`);
      state.markSlackTaskFailed(taskId, `runRootChat threw: ${msg}`);
    });
    finished = true;
    clearInterval(heartbeat);
    clearTimeout(hardTimeout);
  };

  app.event("app_mention", async ({ event, body, client }) => {
    const ev = event as SlackEventCommon;
    const eventId = (body as { event_id?: string }).event_id;
    const text = cleanSlackMentionText(ev.text ?? "");
    if (!text || !ev.channel || !ev.ts) return;
    if (isDuplicate(eventId, ev.channel, ev.ts)) return;
    await addAckReaction(client, ev.channel, ev.ts);
    const enriched = await enrichMessageFromThread(client, ev, text);

    await runFromEvent({
      source: "app_mention",
      eventId,
      event: ev,
      message: enriched,
      rawMessage: text,
      kind: "channel",
      post: async (text, threadTs) => {
        const resp = await client.chat.postMessage({
          channel: ev.channel as string,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text,
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!resp.ok) throw new Error(resp.error ?? "chat.postMessage failed");
        return { ts: resp.ts as string };
      },
      update: async (ts, text) => {
        const resp = await client.chat.update({
          channel: ev.channel as string,
          ts,
          text,
        });
        if (!resp.ok) console.warn(`[slack:post] chat.update failed ts=${ts} err=${resp.error}`);
      },
      uploadFile: async (filePath, caption, threadTs) => {
        try {
          if (!fs.existsSync(filePath)) return;
          const base = {
            channel_id: ev.channel as string,
            filename: filePath.split("/").pop() ?? "screenshot.png",
            file: fs.createReadStream(filePath),
            initial_comment: caption,
          };
          if (threadTs) {
            await client.filesUploadV2({ ...base, thread_ts: threadTs });
          } else {
            await client.filesUploadV2(base);
          }
        } catch (e) {
          console.warn(`[slack:post] file upload failed: ${e}`);
        }
      },
    });
  });

  app.event("message", async ({ event, body, client }) => {
    const ev = event as SlackEventCommon;
    const eventId = (body as { event_id?: string }).event_id;
    if (ev.subtype || ev.bot_id || !ev.channel || !ev.ts) return;

    const text = ev.text ?? "";
    let kind: "direct" | "channel" | null = null;
    let message = "";

    // IMPORTANT: channel mentions are handled by app_mention. Keep message-event
    // processing DM-only to avoid duplicate runs on the same user message.
    if (ev.channel_type === "im") {
      kind = "direct";
      message = text.trim();
    }
    if (!kind || !message) return;
    if (isDuplicate(eventId, ev.channel, ev.ts)) return;
    await addAckReaction(client, ev.channel, ev.ts);
    const enriched = message;

    await runFromEvent({
      source: "message",
      eventId,
      event: ev,
      message: enriched,
      rawMessage: message,
      kind,
      post: async (text, threadTs) => {
        const resp = await client.chat.postMessage({
          channel: ev.channel as string,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text,
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!resp.ok) throw new Error(resp.error ?? "chat.postMessage failed");
        return { ts: resp.ts as string };
      },
      update: async (ts, text) => {
        const resp = await client.chat.update({
          channel: ev.channel as string,
          ts,
          text,
        });
        if (!resp.ok) console.warn(`[slack:post] chat.update failed ts=${ts} err=${resp.error}`);
      },
      uploadFile: async (filePath, caption, threadTs) => {
        try {
          if (!fs.existsSync(filePath)) return;
          const base = {
            channel_id: ev.channel as string,
            filename: filePath.split("/").pop() ?? "screenshot.png",
            file: fs.createReadStream(filePath),
            initial_comment: caption,
          };
          if (threadTs) {
            await client.filesUploadV2({ ...base, thread_ts: threadTs });
          } else {
            await client.filesUploadV2(base);
          }
        } catch (e) {
          console.warn(`[slack:post] file upload failed: ${e}`);
        }
      },
    });
  });

  await app.start();
  started = true;
  console.log("[slack-bolt] Socket Mode started");
}

/**
 * Boot-time recovery: surfaces every Slack message that was in flight
 * when the previous process died. Posts an honest "I crashed, please
 * resend" notice to the thread (editing the placeholder in place when
 * possible) and marks the row 'abandoned'.
 *
 * This is the durability guarantee — once a Slack message lands in the
 * DB, the user is guaranteed to get *some* terminal Slack reply, even
 * if the original process never lived to write it.
 */
async function recoverOrphanedSlackTasks(
  app: App,
  state: State
): Promise<void> {
  const orphans = state.findOrphanedSlackTasks();
  if (orphans.length === 0) {
    console.log("[slack-bolt] no orphaned tasks to recover");
    return;
  }
  console.log(`[slack-bolt] recovering ${orphans.length} orphaned slack task(s)`);

  for (const task of orphans) {
    const headerLine = `_Session: \`${task.langfuseSessionId}\`_\n\n`;
    const body =
      ":boom: *I crashed mid-task and couldn't finish this.* " +
      "Please resend your message in this thread and I'll retry from scratch.";
    const text = headerLine + body;

    try {
      if (task.placeholderTs) {
        const resp = await app.client.chat.update({
          channel: task.channel,
          ts: task.placeholderTs,
          text,
        });
        if (!resp.ok) {
          console.warn(
            `[slack-bolt:recover] chat.update failed taskId=${task.id} err=${resp.error}`
          );
        }
      } else {
        const resp = await app.client.chat.postMessage({
          channel: task.channel,
          ...(task.kind === "channel" ? { thread_ts: task.threadTs } : {}),
          text,
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!resp.ok) {
          console.warn(
            `[slack-bolt:recover] chat.postMessage failed taskId=${task.id} err=${resp.error}`
          );
        }
      }
      state.markSlackTaskAbandoned(
        task.id,
        "process restarted while task was in flight"
      );
      console.log(
        `[slack-bolt:recover] taskId=${task.id} channel=${task.channel} thread=${task.threadTs} marked abandoned`
      );
    } catch (e) {
      console.error(
        `[slack-bolt:recover] failed for taskId=${task.id}: ${(e as Error).message}`
      );
    }
  }
}

/**
 * Global Slack-task poller. Every CHAT_HEARTBEAT_INTERVAL_SEC seconds,
 * scans the DB for tasks that are 'running' but whose updated_at hasn't
 * advanced in CHAT_HEARTBEAT_STUCK_AFTER_SEC seconds. Posts a heartbeat
 * to the thread so the user knows the bot is alive, even if the
 * per-turn heartbeat in runRootChat hasn't been able to pull the agent
 * forward.
 *
 * This is the belt-and-suspenders complement to recoverOrphanedSlackTasks:
 * - recoverOrphanedSlackTasks fires once on boot for crashed runs.
 * - this poller fires continuously for in-flight runs that are slow.
 */
function startSlackTaskPoller(app: App, state: State): void {
  if (!config.heartbeat.enabled) {
    console.log("[slack-bolt:poller] disabled (CHAT_HEARTBEAT_ENABLED=false)");
    return;
  }
  const intervalMs = config.heartbeat.intervalSec * 1000;
  const stuckMs = config.heartbeat.stuckAfterSec * 1000;
  const interval = setInterval(() => {
    let stuck: SlackTask[] = [];
    try {
      stuck = state.findStuckSlackTasks(stuckMs);
    } catch (e) {
      console.warn(`[slack-bolt:poller] db read failed: ${(e as Error).message}`);
      return;
    }
    if (stuck.length === 0) return;
    for (const task of stuck) {
      void nudgeStuckTask(app, state, task);
    }
  }, intervalMs);
  interval.unref();
  console.log(
    `[slack-bolt:poller] started: tick=${config.heartbeat.intervalSec}s stuck-after=${config.heartbeat.stuckAfterSec}s`
  );
}

async function nudgeStuckTask(
  app: App,
  state: State,
  task: SlackTask
): Promise<void> {
  const idleSec = Math.round(
    (Date.now() - new Date(task.updatedAt).getTime()) / 1000
  );
  const headerLine = `_Session: \`${task.langfuseSessionId}\`_\n\n`;
  const body =
    `:hourglass_flowing_sand: *Still working* — no agent activity for ${idleSec}s. ` +
    "The watchdog will keep checking and will mark this run failed if it stays stuck.";
  const text = headerLine + body;

  try {
    if (task.placeholderTs) {
      const resp = await app.client.chat.update({
        channel: task.channel,
        ts: task.placeholderTs,
        text,
      });
      if (!resp.ok) {
        console.warn(
          `[slack-bolt:poller] chat.update failed taskId=${task.id} err=${resp.error}`
        );
      }
    } else {
      const resp = await app.client.chat.postMessage({
        channel: task.channel,
        ...(task.kind === "channel" ? { thread_ts: task.threadTs } : {}),
        text,
      });
      if (!resp.ok) {
        console.warn(
          `[slack-bolt:poller] chat.postMessage failed taskId=${task.id} err=${resp.error}`
        );
      }
    }
    state.markSlackTaskNudged(task.id);
    console.log(
      `[slack-bolt:poller] nudged taskId=${task.id} idle=${idleSec}s`
    );
  } catch (e) {
    console.warn(
      `[slack-bolt:poller] nudge failed taskId=${task.id}: ${(e as Error).message}`
    );
  }
}

async function enrichMessageFromThread(
  client: App["client"],
  event: SlackEventCommon,
  currentMessage: string
): Promise<string> {
  const channel = event.channel;
  const anchorTs = event.thread_ts ?? event.ts;
  if (!channel || !anchorTs) return currentMessage;

  try {
    const replies = await client.conversations.replies({
      channel,
      ts: anchorTs,
      limit: 30,
      inclusive: true,
    });
    if (!replies.ok || !replies.messages?.length) return currentMessage;

    const contextLines = replies.messages
      .filter((m) => !m.bot_id && typeof m.text === "string")
      .map((m) => {
        const t = normalizeSlackText(m.text ?? "");
        if (!t) return "";
        const who = m.user === event.user ? "user" : `user:${m.user ?? "unknown"}`;
        return `${who}: ${t}`;
      })
      .filter(Boolean)
      .slice(-12);

    if (contextLines.length === 0) return currentMessage;
    return [
      "Slack thread context (most recent messages):",
      ...contextLines,
      "",
      "Latest instruction to execute:",
      currentMessage,
    ].join("\n");
  } catch {
    return currentMessage;
  }
}

async function addAckReaction(
  client: App["client"],
  channel: string,
  ts: string
): Promise<void> {
  try {
    const resp = await client.reactions.add({
      channel,
      timestamp: ts,
      name: "eyes",
    });
    if (!resp.ok && resp.error !== "already_reacted") {
      console.warn(`[slack-bolt] reaction add failed: ${resp.error ?? "unknown"}`);
    }
  } catch (e) {
    console.warn("[slack-bolt] reaction add exception:", e);
  }
}

function isDuplicate(eventId: string | undefined, channel: string, ts: string): boolean {
  const messageKey = `${channel}:${ts}`;
  if (seenMessageKeys.has(messageKey)) return true;
  seenMessageKeys.add(messageKey);
  setTimeout(() => seenMessageKeys.delete(messageKey), 24 * 60 * 60 * 1000).unref();

  if (!eventId) return false;
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.add(eventId);
  setTimeout(() => seenEventIds.delete(eventId), 24 * 60 * 60 * 1000).unref();
  return false;
}

function cleanSlackMentionText(text: string): string {
  return normalizeSlackText(text);
}

function normalizeSlackText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function isSlackBotMention(text: string): boolean {
  if (config.slack.botUserId) return text.includes(`<@${config.slack.botUserId}>`);
  return /<@[A-Z0-9]+>/.test(text);
}

function injectSlackContext(message: string, kind: "direct" | "channel"): string {
  return [
    `[Context: triggered from Slack ${kind === "direct" ? "DM" : "channel"} in one-shot PR mode.`,
    `Treat this as a strict repro+fix task. Do not stop at planning text.`,
    `Goal: file a draft PR and include screenshot evidence.`,
    `Hard requirements: return pr_url in write_report; include screenshot proof (before + after + gif) from a running proxy E2E flow.`,
    `Static/local mock HTML render proof is not valid primary PR evidence.`,
    `A pasted feature request or missing GitHub issue URL is NEVER a valid reason to skip PR creation.`,
    `If you can identify a concrete file:line code change, open a draft PR.`,
    `Only skip PR when truly unactionable (pure question / works-as-designed with no code change); then set no_action_reason in write_report.`,
    `If full validation is blocked, still open a draft PR and report blockers explicitly.]`,
    `[MODE=SLACK_ONE_SHOT_PR]`,
    ``,
    message,
  ].join("\n");
}

function truncateSlackText(text: string, max = 3_500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 40)}\n\n... truncated; see runs dashboard for full output.`;
}

async function createGist(description: string, content: string): Promise<string> {
  const resp = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.github.token}`,
      "Content-Type": "application/json",
      "User-Agent": "shin-builder",
    },
    body: JSON.stringify({
      description,
      public: false,
      files: { "report.md": { content } },
    }),
  });
  if (!resp.ok) throw new Error(`GitHub Gist API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { html_url: string };
  return data.html_url;
}

const VERDICT_EMOJI: Record<number, string> = {
  0: "❌",
  1: "⚠️",
  2: "🟡",
  3: "🟠",
  4: "✅",
  5: "🏆",
};

const VERDICT_LABEL: Record<number, string> = {
  0: "Unreproducible",
  1: "Setup failed",
  2: "Partial",
  3: "Similar symptoms",
  4: "Reproduced + root cause",
  5: "Fully validated",
};

function buildScoreCard(p: ReportPayload, gistUrl: string | null): string {
  const emoji = VERDICT_EMOJI[p.verdict] ?? "❓";
  const label = VERDICT_LABEL[p.verdict] ?? "Unknown";
  const lines: string[] = [];

  lines.push(`${emoji} *${p.verdict}/5 — ${label}* | _${p.difficulty} difficulty_`);
  lines.push("");
  lines.push(`> ${p.verdict_reasoning}`);

  if (p.root_cause.length) {
    lines.push("");
    lines.push("*Root cause:*");
    for (const rc of p.root_cause.slice(0, 3)) {
      lines.push(`• \`${rc.file}:${rc.line}\` — ${rc.explanation}`);
    }
  }

  if (p.fix_plan.length) {
    lines.push("");
    lines.push("*Fix:*");
    for (const step of p.fix_plan.slice(0, 3)) {
      lines.push(`• ${step}`);
    }
  }

  if (p.pr_url) {
    lines.push("");
    lines.push(`🔀 *Draft PR:* ${p.pr_url}`);
  }

  if (p.no_action_reason) {
    lines.push("");
    lines.push(`⚪ *No code change actioned:* ${p.no_action_reason}`);
  }

  if (gistUrl) {
    lines.push("");
    lines.push(`📄 *Full report:* ${gistUrl}`);
  }

  return lines.join("\n");
}

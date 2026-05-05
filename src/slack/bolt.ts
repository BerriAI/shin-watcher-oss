import { App } from "@slack/bolt";
import fs from "node:fs";
import { config } from "../config.js";
import { runRootChat } from "../chat/rootChat.js";
import { type ReportPayload, renderReportMarkdown } from "../tools/writeReport.js";

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

    // Post a single placeholder message — all updates edit this in place
    const placeholderText =
      args.kind === "direct"
        ? "I'm looking into this now. I'll keep this DM as the session context."
        : "I'm looking into this now. I'll use this Slack thread as the session context.";
    const { ts: placeholderTs } = await args.post(
      placeholderText,
      args.kind === "direct" ? undefined : threadTs
    );
    console.log(`[slack:post] placeholder ts=${placeholderTs} session=${sessionId}`);

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
      const heartbeatText = accumulated.trim()
        ? truncateSlackText(accumulated.trim()) + "\n\n_... still working, gathering evidence ..._"
        : "_Still working on this. Running checks and gathering evidence..._";
      console.log(`[slack:post] heartbeat update ts=${placeholderTs}`);
      void args.update(placeholderTs, heartbeatText, args.kind === "direct" ? undefined : threadTs);
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
        // Edit the placeholder in place every 10s so the user sees live progress
        const now = Date.now();
        if (accumulated.trim() && now - lastUpdateAt > 10_000) {
          lastUpdateAt = now;
          console.log(`[slack:agent] delta update chars=${accumulated.length} ts=${placeholderTs}`);
          await args.update(
            placeholderTs,
            truncateSlackText(accumulated.trim()) + "\n\n_... thinking ..._",
            args.kind === "direct" ? undefined : threadTs
          );
        }
      },
      onReproStart: async (replySoFar) => {
        lastActivityAt = Date.now();
        const reproText =
          truncateSlackText(replySoFar.trim()) ||
          "Starting the repro run now. You can also watch it in the runs dashboard.";
        console.log(`[slack:agent] repro_start chars=${replySoFar.length} ts=${placeholderTs}`);
        await args.update(
          placeholderTs,
          reproText + "\n\n_... repro run started ..._",
          args.kind === "direct" ? undefined : threadTs
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
          // Update placeholder with structured score card
          const card = buildScoreCard(reportPayload, gistUrl);
          await args.update(placeholderTs, card, args.kind === "direct" ? undefined : threadTs);
        } else {
          await args.update(
            placeholderTs,
            truncateSlackText(reply),
            args.kind === "direct" ? undefined : threadTs
          );
        }
      },
      onError: async (error) => {
        finished = true;
        const isAbort = error.name === "AbortError";
        console.log(`[slack:agent] error name=${error.name} msg=${error.message.slice(0, 120)}`);
        await args.update(
          placeholderTs,
          isAbort
            ? "This run took too long and timed out. Please resend with a tighter scope (or issue URL), and I'll retry."
            : `Sorry, I hit an error: ${truncateSlackText(error.message, 1_500)}`,
          args.kind === "direct" ? undefined : threadTs
        );
      },
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

    if (ev.channel_type === "im") {
      kind = "direct";
      message = text.trim();
    } else if (["channel", "group", "mpim"].includes(ev.channel_type ?? "") && isSlackBotMention(text)) {
      kind = "channel";
      message = cleanSlackMentionText(text);
    }
    if (!kind || !message) return;
    if (isDuplicate(eventId, ev.channel, ev.ts)) return;
    await addAckReaction(client, ev.channel, ev.ts);
    const enriched =
      kind === "channel"
        ? await enrichMessageFromThread(client, ev, message)
        : message;

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
    `[Context: triggered from Slack ${kind === "direct" ? "DM" : "channel"}.`,
    `When you finish a repro run, call write_report as normal — the results will be posted back`,
    `to this Slack thread as a score card (verdict/5, root cause, fix plan) plus a GitHub Gist`,
    `for the full report. Keep your in-thread text concise (Slack truncates at ~3500 chars).`,
    `Do NOT post a GitHub comment unless the issue came in with a real GitHub issue URL/number.]`,
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

  if (gistUrl) {
    lines.push("");
    lines.push(`📄 *Full report:* ${gistUrl}`);
  }

  return lines.join("\n");
}

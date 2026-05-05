import { App } from "@slack/bolt";
import { config } from "../config.js";
import { runRootChat } from "../chat/rootChat.js";

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
    message: string;
    kind: "direct" | "channel";
    post: (text: string, threadTs?: string) => Promise<void>;
  }): Promise<void> => {
    const event = args.event;
    const teamId = "socket";
    const threadTs = event.thread_ts ?? event.ts ?? String(Date.now() / 1000);
    const sessionId =
      args.kind === "direct"
        ? `slack:direct:${teamId}:${event.channel ?? "unknown"}:${event.user ?? "unknown"}`
        : `slack:channel:${teamId}:${event.channel ?? "unknown"}:thread:${threadTs}`;

    await args.post(
      args.kind === "direct"
        ? "I'm looking into this now. I'll keep this DM as the session context."
        : "I'm looking into this now. I'll use this Slack thread as the session context.",
      args.kind === "direct" ? undefined : threadTs
    );

    let buffered = "";
    let lastProgressAt = 0;
    await runRootChat({
      sessionId,
      message: args.message,
      onDelta: async (delta) => {
        buffered += delta;
        const now = Date.now();
        if (buffered.trim() && now - lastProgressAt > 15_000) {
          lastProgressAt = now;
          await args.post(truncateSlackText(buffered.trim()), args.kind === "direct" ? undefined : threadTs);
          buffered = "";
        }
      },
      onReproStart: async (replySoFar) => {
        await args.post(
          truncateSlackText(replySoFar.trim()) ||
            "Starting the repro run now. You can also watch it in the runs dashboard.",
          args.kind === "direct" ? undefined : threadTs
        );
      },
      onDone: async (reply) => {
        await args.post(truncateSlackText(reply), args.kind === "direct" ? undefined : threadTs);
      },
      onError: async (error) => {
        await args.post(
          `Sorry, I hit an error: ${truncateSlackText(error.message, 1_500)}`,
          args.kind === "direct" ? undefined : threadTs
        );
      },
    });
  };

  app.event("app_mention", async ({ event, body, client }) => {
    const ev = event as SlackEventCommon;
    const eventId = (body as { event_id?: string }).event_id;
    const text = cleanSlackMentionText(ev.text ?? "");
    if (!text || !ev.channel || !ev.ts) return;
    if (isDuplicate(eventId, ev.channel, ev.ts)) return;
    await addAckReaction(client, ev.channel, ev.ts);

    await runFromEvent({
      source: "app_mention",
      eventId,
      event: ev,
      message: text,
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

    await runFromEvent({
      source: "message",
      eventId,
      event: ev,
      message,
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
      },
    });
  });

  await app.start();
  started = true;
  console.log("[slack-bolt] Socket Mode started");
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
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function isSlackBotMention(text: string): boolean {
  if (config.slack.botUserId) return text.includes(`<@${config.slack.botUserId}>`);
  return /<@[A-Z0-9]+>/.test(text);
}

function truncateSlackText(text: string, max = 3_500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 40)}\n\n... truncated; see runs dashboard for full output.`;
}

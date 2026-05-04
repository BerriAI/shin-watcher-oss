import express, { type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { LiveBus, type LiveEvent } from "./live.js";
import { SessionManager, awaitSessionAgent } from "./session.js";
import { config } from "../config.js";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { Picker } from "../picker.js";
import { State } from "../state.js";
import { runRootChat } from "../chat/rootChat.js";
import { startSlackBolt } from "../slack/bolt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, "ui");

/**
 * Pick up to `batchSize` unprocessed issues and fire one root-agent session
 * per issue. Issues are sent sequentially with a short stagger so they don't
 * all try to clone + boot a proxy at the same instant.
 */
/** Unix ms timestamp of when the next scheduled batch will fire. 0 = scheduler disabled. */
let nextBatchAt = 0;
const seenSlackEvents = new Set<string>();
const seenSlackMessageKeys = new Set<string>();
const slackPollBootstrappedChannels = new Set<string>();
const slackDebugEvents: SlackDebugEvent[] = [];

async function runBatch(batchSize: number): Promise<void> {
  const state = new State(config.paths.stateDb);
  const picker = new Picker(
    config.github.token,
    config.github.targetOwner,
    config.github.targetRepo,
    state
  );

  const issues = await picker.pickBatch(batchSize);
  if (issues.length === 0) {
    console.log("[scheduler] no eligible issues found");
    return;
  }

  console.log(`[scheduler] starting batch of ${issues.length} issues`);

  for (const issue of issues) {
    const sessionId = `batch-${issue.number}-${Date.now()}`;
    const msg =
      `Reproduce issue #${issue.number} on ` +
      `${config.github.targetOwner}/${config.github.targetRepo} ` +
      `and post your findings as a comment on the issue.`;

    console.log(`[scheduler] queuing #${issue.number}: ${issue.title}`);

    // Show immediately in Active Now before agent boots.
    LiveBus.queueRun(issue, sessionId);

    // Fire-and-forget — each runs in its own session.
    setImmediate(async () => {
      try {
        const session = SessionManager.getOrCreate(sessionId);
        const agent = await awaitSessionAgent(session, 120_000);
        await (agent as unknown as { prompt: (m: string) => Promise<void> }).prompt(msg);
      } catch (e) {
        console.error(`[scheduler] issue #${issue.number} failed:`, e);
      }
    });

    // Stagger starts by 10s so clones don't all hit disk at once.
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

export function startDashboard(port = 3333): void {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/login", (_req, res) => {
    res.type("html").send(renderLoginPage());
  });

  app.post("/login", (req, res) => {
    const { username, password } = req.body as {
      username?: string;
      password?: string;
    };
    if (
      username === config.dashboard.username &&
      password === config.dashboard.password
    ) {
      res.setHeader("Set-Cookie", serializeSessionCookie(makeSessionCookie()));
      return res.redirect("/");
    }
    return res.status(401).type("html").send(renderLoginPage("Invalid username or password."));
  });

  app.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", serializeExpiredSessionCookie());
    res.redirect("/login");
  });

  const boltEnabled = config.slack.useBolt;
  // Bolt-only mode: no HTTP Slack ingestion route.
  if (!boltEnabled) {
    console.warn("[slack] Slack integration disabled (SLACK_USE_BOLT=false)");
  }

  app.use(requireDashboardAuth);
  app.use("/ui", express.static(UI_DIR));

  // ── Pages ──────────────────────────────────────────────────────────────────

  app.get("/", (_req, res) => res.sendFile(path.join(UI_DIR, "chat.html")));
  app.get("/runs", (_req, res) => res.sendFile(path.join(UI_DIR, "runs.html")));

  // ── API: status ────────────────────────────────────────────────────────────

  app.get("/api/status", (_req, res) => {
    const active = LiveBus.getActiveRuns();
    res.json({
      busy: active.length > 0,
      active: active.map((r) => ({
        taskId: r.taskId,
        issueNumber: r.issue.number,
        issueTitle: r.issue.title,
        issueUrl: r.issue.htmlUrl,
        startedAt: r.startedAt,
        phase: r.phase,
      })),
    });
  });

  app.get("/api/slack/debug", (_req, res) => {
    res.json({
      configured: {
        signingSecret: Boolean(config.slack.signingSecret),
        botToken: Boolean(config.slack.botToken),
      },
      recent: slackDebugEvents.slice(0, 50),
    });
  });

  // ── API: upcoming issues (picker preview) ─────────────────────────────────

  app.get("/api/upcoming", async (_req, res) => {
    try {
      const state = new State(config.paths.stateDb);
      const picker = new Picker(
        config.github.token,
        config.github.targetOwner,
        config.github.targetRepo,
        state
      );
      const issues = await picker.pickBatch(15);
      state.close();
      const STAGGER_MS = 10_000; // 10s between each issue start within a batch
      res.json({
        nextBatchAt: nextBatchAt || null,
        batchSize: config.schedule.batchSize,
        schedulerEnabled: config.schedule.batchIntervalMin > 0,
        issues: issues.map((i, idx) => ({
          number: i.number,
          title: i.title,
          htmlUrl: i.htmlUrl,
          author: i.author,
          labels: i.labels,
          createdAt: i.createdAt,
          // When this issue is expected to start within the next batch.
          expectedAt: nextBatchAt ? nextBatchAt + idx * STAGGER_MS : null,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── API: manually trigger a single issue ──────────────────────────────────

  app.post("/api/run-issue/:number", async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: "unauthorized" }); return; }
    const issueNumber = parseInt(req.params.number, 10);
    if (isNaN(issueNumber)) {
      res.status(400).json({ error: "invalid issue number" });
      return;
    }
    const sessionId = `manual-${issueNumber}-${Date.now()}`;
    const msg =
      `Reproduce issue #${issueNumber} on ` +
      `${config.github.targetOwner}/${config.github.targetRepo} ` +
      `and post your findings as a comment on the issue.`;

    // Immediately register in LiveBus so it shows in Active Now while the agent boots.
    try {
      const state = new State(config.paths.stateDb);
      const picker = new Picker(config.github.token, config.github.targetOwner, config.github.targetRepo, state);
      const issue = await picker.fetchOne(issueNumber);
      state.close();
      LiveBus.queueRun(issue, sessionId);
    } catch {
      // If we can't fetch the issue, still proceed — the agent will handle it.
      LiveBus.queueRun(
        { number: issueNumber, title: `Issue #${issueNumber}`, body: "", htmlUrl: `https://github.com/${config.github.targetOwner}/${config.github.targetRepo}/issues/${issueNumber}`, author: "", labels: [], createdAt: new Date().toISOString(), recentComments: [] },
        sessionId
      );
    }

    setImmediate(async () => {
      try {
        const session = SessionManager.getOrCreate(sessionId);
        const agent = await awaitSessionAgent(session, 120_000);
        await (agent as unknown as { prompt: (m: string) => Promise<void> }).prompt(msg);
      } catch (e) {
        console.error(`[manual] issue #${issueNumber} failed:`, e);
        // Remove stale queued placeholder on failure
        LiveBus.endRun(`queued-${issueNumber}`);
      }
    });
    res.json({ ok: true, sessionId });
  });

  // ── API: recent history ────────────────────────────────────────────────────

  app.get("/api/history", (_req, res) => {
    try {
      const db = new Database(config.paths.stateDb, { readonly: true });
      const rows = db
        .prepare(
          `SELECT issue_number, attempted_at, verdict, difficulty, pr_url, duration_ms, error_message, report_path
           FROM attempts ORDER BY attempted_at DESC LIMIT 20`
        )
        .all();
      db.close();
      res.json(rows);
    } catch {
      res.json([]);
    }
  });

  // ── SSE: global event stream (all runs) ───────────────────────────────────

  app.get("/live", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: "connected" });

    const onEvent = (live: LiveEvent) =>
      send({
        ...live.event,
        taskId: live.taskId,
        session_id: LiveBus.getChatSessionForTask(live.taskId) ?? null,
      });
    const onStart = (payload: object) => send({ type: "run_start", ...payload });
    const onEnd = (payload: object) => send({ type: "run_end", ...payload });
    const onNoIssue = () => send({ type: "no_eligible_issue" });
    const onSetup = (payload: object) => send(payload);
    const onSetupError = (payload: object) => send(payload);
    const onAgentReady = (payload: object) => send(payload);
    const onPlan = (payload: object) => send(payload);

    LiveBus.on("agent_event", onEvent);
    LiveBus.on("run_start", onStart);
    LiveBus.on("run_end", onEnd);
    LiveBus.on("no_eligible_issue", onNoIssue);
    LiveBus.on("run_setup", onSetup);
    LiveBus.on("run_setup_error", onSetupError);
    LiveBus.on("run_agent_ready", onAgentReady);
    LiveBus.on("run_plan", onPlan);

    const cleanup = () => {
      LiveBus.off("agent_event", onEvent);
      LiveBus.off("run_start", onStart);
      LiveBus.off("run_end", onEnd);
      LiveBus.off("no_eligible_issue", onNoIssue);
      LiveBus.off("run_setup", onSetup);
      LiveBus.off("run_setup_error", onSetupError);
      LiveBus.off("run_agent_ready", onAgentReady);
      LiveBus.off("run_plan", onPlan);
    };
    req.on("close", cleanup);
  });

  /**
   * Free-form chat via the root agent.  The agent decides autonomously whether
   * to answer in plain text or launch a full repro run.  Text deltas are
   * streamed back as SSE.  When the agent calls begin_repro_run the HTTP
   * response finishes immediately (repro continues in background).
   */
  app.post("/api/chat", async (req, res) => {
    const body = req.body as {
      messages?: Array<{ role: string; content: string }>;
      /** Browser-generated id for this chat tab/session. */
      session_id?: string;
    };
    const chatSessionId =
      typeof body.session_id === "string" && body.session_id.trim() !== ""
        ? body.session_id.trim()
        : `anon-${Date.now()}`;

    const msgs = body.messages;
    if (!msgs?.length) return res.status(400).json({ error: "messages required" });
    const last = msgs[msgs.length - 1];
    if (last?.role !== "user") return res.status(400).json({ error: "last message must be user" });

    const userMessage = last.content;

    // Always stream — the session agent produces real-time events.
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (obj: object) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    let detachedForRepro = false;
    let replyAcc = "";

    // Get (or lazily create) the session's root agent.
    let agent;
    try {
      const session = SessionManager.getOrCreate(chatSessionId);
      session.lastActivityAt = Date.now();
      agent = await awaitSessionAgent(session);
    } catch (e) {
      send({ type: "error", message: `Session init failed: ${(e as Error).message}` });
      res.end();
      return;
    }

    // Subscribe to agent events for the duration of this HTTP request.
    // We keep forwarding=true until the request closes or repro detaches.
    let forwarding = true;
    const session = SessionManager.getOrCreate(chatSessionId);

    agent.subscribe((event: AgentEvent) => {
      if (!forwarding) return;
      const ev = event as Record<string, unknown>;

      // Stream text deltas to the client.
      if (ev["type"] === "message_update") {
        const ae = ev["assistantMessageEvent"] as Record<string, unknown> | undefined;
        if (ae?.["type"] === "text_delta" && typeof ae["delta"] === "string") {
          replyAcc += ae["delta"];
          send({ type: "delta", text: ae["delta"] });
        }
      }

      // When the agent calls begin_repro_run, the repro runs in background.
      // Close the HTTP response immediately so the chat bubble resolves.
      if (ev["type"] === "tool_call" && ev["name"] === "begin_repro_run" && !detachedForRepro) {
        detachedForRepro = true;
        forwarding = false;
        send({
          type: "done",
          reply: replyAcc || "Starting reproduction — follow the live panel for progress.",
          repro: true,
          session_id: chatSessionId,
        });
        res.end();
      }
    });

    const ac = new AbortController();
    res.on("close", () => {
      forwarding = false;
      if (!detachedForRepro) ac.abort();
    });

    try {
      // agent.prompt() resolves when the current turn is complete.
      // If a repro was started it will continue running after prompt() returns.
      await (agent as unknown as { prompt: (msg: string, opts?: { signal?: AbortSignal }) => Promise<void> })
        .prompt(userMessage);
    } catch (e) {
      const msg = (e as Error).message;
      if (!detachedForRepro && !res.writableEnded) {
        send({ type: "error", message: msg });
      }
    } finally {
      forwarding = false;
    }

    if (!detachedForRepro && !res.writableEnded) {
      send({
        type: "done",
        reply: replyAcc || "(no reply)",
        repro: !!session.currentTaskId,
        session_id: chatSessionId,
      });
      res.end();
    }
  });

  // ── POST: invoke ──────────────────────────────────────────────────────────
  // Accepts: issue number, GitHub URL, or any freeform command.
  // Routes the text directly to the root session agent (which decides what to do).

  app.post("/api/invoke", async (req, res) => {
    const { command, steerMessage } = req.body as { command?: string; steerMessage?: string };
    const raw = (command ?? "").trim();

    res.json({ queued: true, command: raw });

    const sessionId = `invoke-${Date.now()}`;
    setImmediate(async () => {
      try {
        const session = SessionManager.getOrCreate(sessionId);
        const agent = await awaitSessionAgent(session);
        const msg = steerMessage
          ? `${raw}\n\nAdditional context: ${steerMessage}`
          : raw || "Pick the next eligible open bug and reproduce it.";
        await (agent as unknown as { prompt: (m: string) => Promise<void> }).prompt(msg);
      } catch (e) {
        console.error("[dashboard] invoke error:", e);
      }
    });
  });

  app.post("/api/interrupt", (_req, res) => {
    const active = LiveBus.getActiveRuns();
    if (active.length === 0) {
      return res.json({ ok: false, message: "No active run to interrupt." });
    }
    for (const run of active) {
      run.agent?.abort();
    }
    res.json({ ok: true, interrupted: active.map((r) => r.taskId) });
  });

  // ── POST: steer (inject mid-run message) ─────────────────────────────────

  app.post("/api/steer", async (req, res) => {
    const { message, taskId } = req.body as { message?: string; taskId?: string };
    if (!message?.trim()) return res.status(400).json({ error: "message required" });

    const active = LiveBus.getActiveRuns();
    if (active.length === 0) {
      return res.status(410).json({ error: "No active run to steer." });
    }

    const run = taskId
      ? active.find((r) => r.taskId === taskId) ?? active[0]!
      : active[0]!;
    if (!run.agent) {
      return res.status(409).json({ error: "Run is still setting up; agent is not ready." });
    }
    run.agent.prompt(message).catch(() => {});

    // Emit the steer as a synthetic event so it appears in the chat
    LiveBus.pushEvent(run.taskId, {
      type: "tool_execution_start",
      toolCallId: "steer",
      toolName: "__steer__",
      args: { message },
    });

    res.json({ ok: true, taskId: run.taskId });
  });

  // ── API: transcript ───────────────────────────────────────────────────────

  app.get("/api/runs/:taskId/transcript", (req, res) => {
    const transcriptPath = path.join(config.paths.runs, req.params["taskId"] as string, "transcript.jsonl");
    if (!fs.existsSync(transcriptPath)) return res.status(404).json([]);
    const lines = fs.readFileSync(transcriptPath, "utf-8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    res.json(lines);
  });

  // ── Static: screenshots ───────────────────────────────────────────────────

  app.get("/runs/:taskId/screenshots/:file", (req, res) => {
    const imgPath = path.join(
      config.paths.runs,
      req.params["taskId"] as string,
      "screenshots",
      req.params["file"] as string
    );
    if (!fs.existsSync(imgPath)) return res.status(404).send("not found");
    res.sendFile(imgPath);
  });

  // ── Internal batch scheduler ──────────────────────────────────────────────
  // If BATCH_INTERVAL_MIN > 0, picks up to BATCH_SIZE unprocessed issues and
  // fires a repro session for each on that cadence. No external trigger needed.

  if (config.schedule.batchIntervalMin > 0) {
    const intervalMs = config.schedule.batchIntervalMin * 60_000;
    const runScheduledBatch = () => {
      nextBatchAt = Date.now() + intervalMs;
      runBatch(config.schedule.batchSize).catch((e) =>
        console.error("[scheduler] batch error:", e)
      );
    };
    // Fire once shortly after startup, then on interval.
    const firstFireMs = 30_000;
    nextBatchAt = Date.now() + firstFireMs;
    setTimeout(runScheduledBatch, firstFireMs);
    setInterval(runScheduledBatch, intervalMs);
    console.log(
      `  Scheduler   →  every ${config.schedule.batchIntervalMin}m, ${config.schedule.batchSize} issues/batch\n`
    );
  }

  // Slack poll fallback intentionally disabled in Bolt-only mode.

  app.listen(port, () => {
    console.log(`\n  Dashboard  →  http://localhost:${port}\n`);
    if (boltEnabled) {
      void startSlackBolt().catch((e) =>
        console.error("[slack-bolt] failed to start:", e)
      );
    }
  });
}

type SlackRequest = Request & { rawBody?: Buffer };

interface SlackDebugEvent {
  ts: string;
  stage: "received" | "ignored" | "routed" | "posted" | "post_failed" | "signature_failed";
  reason?: string;
  eventId?: string;
  envelopeType?: string;
  eventType?: string;
  subtype?: string;
  channel?: string;
  channelType?: string;
  user?: string;
  sessionId?: string;
  textPreview?: string;
  slackError?: string;
}

interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    text?: string;
    user?: string;
    bot_id?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
  };
}

function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  (req as SlackRequest).rawBody = Buffer.from(buf);
}

function handleSlackEvents(req: Request, res: Response): void {
  if (!verifySlackSignature(req as SlackRequest)) {
    recordSlackDebug({
      stage: "signature_failed",
      reason: "Slack signature verification failed",
    });
    res.status(401).send("invalid slack signature");
    return;
  }

  const body = req.body as SlackEventEnvelope;
  recordSlackDebug({
    stage: "received",
    eventId: body.event_id,
    envelopeType: body.type,
    eventType: body.event?.type,
    subtype: body.event?.subtype,
    channel: body.event?.channel,
    channelType: body.event?.channel_type,
    user: body.event?.user,
    textPreview: body.event?.text,
  });

  if (body.type === "url_verification") {
    recordSlackDebug({
      stage: "routed",
      reason: "url_verification challenge",
      envelopeType: body.type,
    });
    res.json({ challenge: body.challenge });
    return;
  }

  if (body.type !== "event_callback") {
    recordSlackDebug({
      stage: "ignored",
      reason: "not event_callback",
      eventId: body.event_id,
      envelopeType: body.type,
    });
    res.status(200).send("ok");
    return;
  }

  const event = body.event;
  if (!event || event.bot_id || event.subtype || !event.channel || !event.ts) {
    recordSlackDebug({
      stage: "ignored",
      reason: !event
        ? "missing event"
        : event.bot_id
          ? "bot event"
          : event.subtype
            ? `subtype ${event.subtype}`
            : "missing channel or ts",
      eventId: body.event_id,
      eventType: event?.type,
      subtype: event?.subtype,
      channel: event?.channel,
      channelType: event?.channel_type,
      user: event?.user,
      textPreview: event?.text,
    });
    res.status(200).send("ok");
    return;
  }

  const messageKey = `${event.channel}:${event.ts}`;
  if (seenSlackMessageKeys.has(messageKey)) {
    recordSlackDebug({
      stage: "ignored",
      reason: "duplicate message key",
      eventId: body.event_id,
      eventType: event.type,
      channel: event.channel,
      channelType: event.channel_type,
    });
    res.status(200).send("ok");
    return;
  }
  seenSlackMessageKeys.add(messageKey);
  setTimeout(() => seenSlackMessageKeys.delete(messageKey), 24 * 60 * 60 * 1000).unref();

  const route = classifySlackEvent(event);
  if (!route) {
    recordSlackDebug({
      stage: "ignored",
      reason: "not app_mention or message.im",
      eventId: body.event_id,
      eventType: event.type,
      channel: event.channel,
      channelType: event.channel_type,
      user: event.user,
      textPreview: event.text,
    });
    res.status(200).send("ok");
    return;
  }

  if (body.event_id && seenSlackEvents.has(body.event_id)) {
    recordSlackDebug({
      stage: "ignored",
      reason: "duplicate event_id",
      eventId: body.event_id,
      eventType: event.type,
      channel: event.channel,
      channelType: event.channel_type,
    });
    res.status(200).send("ok");
    return;
  }
  if (body.event_id) {
    seenSlackEvents.add(body.event_id);
    setTimeout(() => seenSlackEvents.delete(body.event_id as string), 10 * 60_000).unref();
  }

  res.status(200).send("ok");

  const teamId = body.team_id ?? "unknown";
  const threadTs = event.thread_ts ?? event.ts;
  const sessionId =
    route.kind === "direct"
      ? `slack:direct:${teamId}:${event.channel}:${event.user ?? "unknown"}`
      : `slack:channel:${teamId}:${event.channel}:thread:${threadTs}`;
  const message = route.message;
  recordSlackDebug({
    stage: "routed",
    reason: route.kind,
    eventId: body.event_id,
    eventType: event.type,
    channel: event.channel,
    channelType: event.channel_type,
    user: event.user,
    sessionId,
    textPreview: message,
  });

  setImmediate(async () => {
    const initial = await postSlackMessage({
      channel: event.channel as string,
      threadTs: route.kind === "direct" ? undefined : threadTs,
      text:
        route.kind === "direct"
          ? "I'm looking into this now. I'll keep this DM as the session context."
          : "I'm looking into this now. I'll use this Slack thread as the session context.",
    });

    let buffered = "";
    let lastProgressAt = 0;
    await runRootChat({
      sessionId,
      message,
      onDelta: async (delta) => {
        buffered += delta;
        const now = Date.now();
        if (buffered.trim() && now - lastProgressAt > 15_000) {
          lastProgressAt = now;
          await postSlackMessage({
            channel: event.channel as string,
            threadTs: route.kind === "direct" ? undefined : threadTs,
            text: truncateSlackText(buffered.trim()),
          });
          buffered = "";
        }
      },
      onReproStart: async (replySoFar) => {
        await postSlackMessage({
          channel: event.channel as string,
          threadTs: route.kind === "direct" ? undefined : threadTs,
          text:
            truncateSlackText(replySoFar.trim()) ||
            "Starting the repro run now. You can also watch it in the runs dashboard.",
        });
      },
      onDone: async (reply) => {
        await postSlackMessage({
          channel: event.channel as string,
          threadTs: route.kind === "direct" ? undefined : threadTs,
          text: truncateSlackText(reply),
        });
      },
      onError: async (error) => {
        await postSlackMessage({
          channel: event.channel as string,
          threadTs: route.kind === "direct" ? undefined : threadTs,
          text: `Sorry, I hit an error: ${truncateSlackText(error.message, 1_500)}`,
        });
      },
    });

    if (!initial.ok) {
      console.warn("[slack] initial post failed:", initial.error);
      recordSlackDebug({
        stage: "post_failed",
        reason: "initial acknowledgement failed",
        eventId: body.event_id,
        eventType: event.type,
        channel: event.channel,
        channelType: event.channel_type,
        user: event.user,
        sessionId,
        slackError: initial.error,
      });
    } else {
      recordSlackDebug({
        stage: "posted",
        reason: "initial acknowledgement sent",
        eventId: body.event_id,
        eventType: event.type,
        channel: event.channel,
        channelType: event.channel_type,
        user: event.user,
        sessionId,
      });
    }
  });
}

function verifySlackSignature(req: SlackRequest): boolean {
  if (!config.slack.signingSecret) return false;
  const timestamp = req.get("x-slack-request-timestamp");
  const signature = req.get("x-slack-signature");
  const rawBody = req.rawBody;
  if (!timestamp || !signature || !rawBody) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 5 * 60) return false;

  const base = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const expected =
    "v0=" +
    crypto.createHmac("sha256", config.slack.signingSecret).update(base).digest("hex");
  return secureEqual(signature, expected);
}

function cleanSlackMentionText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function recordSlackDebug(event: Omit<SlackDebugEvent, "ts">): void {
  const entry: SlackDebugEvent = {
    ts: new Date().toISOString(),
    ...event,
    textPreview:
      typeof event.textPreview === "string"
        ? truncateSlackText(event.textPreview.replace(/\s+/g, " "), 180)
        : undefined,
  };
  slackDebugEvents.unshift(entry);
  slackDebugEvents.length = Math.min(slackDebugEvents.length, 100);
  console.log(
    `[slack] ${entry.stage}` +
      (entry.reason ? ` reason=${entry.reason}` : "") +
      (entry.eventType ? ` event=${entry.eventType}` : "") +
      (entry.channel ? ` channel=${entry.channel}` : "") +
      (entry.channelType ? ` channel_type=${entry.channelType}` : "") +
      (entry.sessionId ? ` session=${entry.sessionId}` : "")
  );
}

function classifySlackEvent(
  event: NonNullable<SlackEventEnvelope["event"]>
): { kind: "direct" | "channel"; message: string } | null {
  const text = event.text ?? "";

  // OpenClaw-style: DMs are normal inbound messages, no mention required.
  if (event.type === "message" && event.channel_type === "im") {
    const message = text.trim();
    return message ? { kind: "direct", message } : null;
  }

  // Channel/group conversations are mention-gated by Slack's app_mention event.
  if (event.type === "app_mention") {
    const message = cleanSlackMentionText(text);
    return message ? { kind: "channel", message } : null;
  }

  // OpenClaw-style fallback: if the workspace subscribes to message.channels
  // / message.groups, we still require an explicit bot mention before routing.
  if (
    event.type === "message" &&
    ["channel", "group", "mpim"].includes(event.channel_type ?? "") &&
    isSlackBotMention(text)
  ) {
    const message = cleanSlackMentionText(text);
    return message ? { kind: "channel", message } : null;
  }

  return null;
}

function isSlackBotMention(text: string): boolean {
  if (config.slack.botUserId) {
    return text.includes(`<@${config.slack.botUserId}>`);
  }
  // Fallback for local/dev when bot user id is not configured. This is still
  // mention-gated but may route messages mentioning other users too, so set
  // SLACK_BOT_USER_ID in production.
  return /<@[A-Z0-9]+>/.test(text);
}

interface SlackHistoryMessage {
  type?: string;
  subtype?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  thread_ts?: string;
}

async function pollSlackChannels(channels: string[]): Promise<void> {
  for (const channel of channels) {
    const response = await fetch("https://slack.com/api/conversations.history", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.slack.botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ channel, limit: "20" }),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      messages?: SlackHistoryMessage[];
    };
    if (!data.ok) {
      recordSlackDebug({
        stage: "post_failed",
        reason: "poll conversations.history failed",
        channel,
        channelType: "channel",
        slackError: data.error ?? response.statusText,
      });
      continue;
    }

    const messages = (data.messages ?? []).slice().reverse();
    if (!slackPollBootstrappedChannels.has(channel)) {
      for (const m of messages) {
        if (!m.ts) continue;
        seenSlackMessageKeys.add(`${channel}:${m.ts}`);
      }
      slackPollBootstrappedChannels.add(channel);
      recordSlackDebug({
        stage: "ignored",
        reason: `poll bootstrap seeded ${messages.length} messages`,
        channel,
        channelType: "channel",
      });
      continue;
    }

    for (const m of messages) {
      if (!m.ts || m.bot_id || m.subtype) continue;
      const text = m.text ?? "";
      if (!isSlackBotMention(text)) continue;

      const messageKey = `${channel}:${m.ts}`;
      if (seenSlackMessageKeys.has(messageKey)) continue;
      seenSlackMessageKeys.add(messageKey);
      setTimeout(() => seenSlackMessageKeys.delete(messageKey), 24 * 60 * 60 * 1000).unref();

      const cleaned = cleanSlackMentionText(text);
      if (!cleaned) continue;

      const eventId = `poll:${channel}:${m.ts}`;
      const threadTs = m.thread_ts ?? m.ts;
      const sessionId = `slack:channel:poll:${channel}:thread:${threadTs}`;
      recordSlackDebug({
        stage: "received",
        reason: "poll fallback",
        eventId,
        eventType: "message",
        channel,
        channelType: "channel",
        user: m.user,
        textPreview: text,
      });
      recordSlackDebug({
        stage: "routed",
        reason: "channel",
        eventId,
        eventType: "message",
        channel,
        channelType: "channel",
        user: m.user,
        sessionId,
        textPreview: cleaned,
      });

      setImmediate(async () => {
        const initial = await postSlackMessage({
          channel,
          threadTs,
          text: "I'm looking into this now. (poll fallback) I'll use this Slack thread as the session context.",
        });
        if (!initial.ok) {
          recordSlackDebug({
            stage: "post_failed",
            reason: "initial acknowledgement failed",
            eventId,
            eventType: "message",
            channel,
            channelType: "channel",
            user: m.user,
            sessionId,
            slackError: initial.error,
          });
          return;
        }
        recordSlackDebug({
          stage: "posted",
          reason: "initial acknowledgement sent",
          eventId,
          eventType: "message",
          channel,
          channelType: "channel",
          user: m.user,
          sessionId,
        });

        let buffered = "";
        let lastProgressAt = 0;
        await runRootChat({
          sessionId,
          message: cleaned,
          onDelta: async (delta) => {
            buffered += delta;
            const now = Date.now();
            if (buffered.trim() && now - lastProgressAt > 15_000) {
              lastProgressAt = now;
              await postSlackMessage({
                channel,
                threadTs,
                text: truncateSlackText(buffered.trim()),
              });
              buffered = "";
            }
          },
          onReproStart: async (replySoFar) => {
            await postSlackMessage({
              channel,
              threadTs,
              text:
                truncateSlackText(replySoFar.trim()) ||
                "Starting the repro run now. You can also watch it in the runs dashboard.",
            });
          },
          onDone: async (reply) => {
            await postSlackMessage({
              channel,
              threadTs,
              text: truncateSlackText(reply),
            });
          },
          onError: async (error) => {
            await postSlackMessage({
              channel,
              threadTs,
              text: `Sorry, I hit an error: ${truncateSlackText(error.message, 1_500)}`,
            });
          },
        });
      });
    }
  }
}

async function postSlackMessage(args: {
  channel: string;
  threadTs?: string;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!config.slack.botToken) {
    console.warn("[slack] SLACK_BOT_TOKEN missing; would have posted:", args.text);
    return { ok: false, error: "missing SLACK_BOT_TOKEN" };
  }
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channel,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
      text: args.text,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });
  const body = (await response.json()) as { ok?: boolean; error?: string };
  return body.ok ? { ok: true } : { ok: false, error: body.error ?? response.statusText };
}

function truncateSlackText(text: string, max = 3_500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 40)}\n\n... truncated; see runs dashboard for full output.`;
}

// Parse a GitHub issue number from various input formats — kept for future use.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _parseIssueNumber(input: string): number | null {
  // GitHub URL
  const urlMatch = input.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1] as string, 10);
  // #number or plain number
  const numMatch = input.match(/#?(\d+)/);
  if (numMatch) return parseInt(numMatch[1] as string, 10);
  return null;
}

function requireDashboardAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (isAuthorized(req)) {
    next();
    return;
  }

  const browserPage =
    req.method === "GET" &&
    !req.path.startsWith("/api/") &&
    req.path !== "/live" &&
    !req.path.startsWith("/runs/");
  if (browserPage) {
    res.redirect("/login");
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}

function isAuthorized(req: Request): boolean {
  const masterKey = config.dashboard.masterKey;
  const headerKey = req.get("x-api-key") ?? req.get("x-shin-key");
  const auth = req.get("authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1];

  return (
    secureEqual(headerKey, masterKey) ||
    secureEqual(bearer, masterKey) ||
    verifySessionCookie(readCookie(req, "shin_dashboard_session"))
  );
}

function secureEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function makeSessionCookie(): string {
  const issuedAt = Date.now().toString();
  const payload = Buffer.from(issuedAt).toString("base64url");
  const sig = crypto
    .createHmac("sha256", config.dashboard.sessionSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

function verifySessionCookie(value: string | undefined): boolean {
  if (!value) return false;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return false;

  const expected = crypto
    .createHmac("sha256", config.dashboard.sessionSecret)
    .update(payload)
    .digest("base64url");
  if (!secureEqual(sig, expected)) return false;

  const issuedAtRaw = Buffer.from(payload, "base64url").toString("utf8");
  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAt)) return false;
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  return Date.now() - issuedAt < maxAgeMs;
}

function readCookie(req: Request, name: string): string | undefined {
  const cookie = req.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function serializeSessionCookie(value: string): string {
  const parts = [
    `shin_dashboard_session=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=604800",
  ];
  if (config.dashboard.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

function serializeExpiredSessionCookie(): string {
  const parts = [
    "shin_dashboard_session=",
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  if (config.dashboard.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

function renderLoginPage(error?: string): string {
  const err = error
    ? `<div class="err">${escapeHtml(error)}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>shin-watcher login</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #0d0d0f; color: #e2e4ec;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    form {
      width: min(360px, calc(100vw - 32px)); padding: 24px;
      border: 1px solid #25262c; border-radius: 14px; background: #18191e;
      box-shadow: 0 20px 80px rgba(0,0,0,.35);
    }
    h1 { margin: 0 0 6px; font-size: 18px; }
    p { margin: 0 0 20px; color: #8b8d98; font-size: 13px; line-height: 1.5; }
    label { display: block; margin: 12px 0 6px; color: #b6b8c4; font-size: 12px; font-weight: 600; }
    input {
      width: 100%; border: 1px solid #25262c; background: #101116; color: #e2e4ec;
      border-radius: 8px; padding: 10px 12px; font-size: 14px; outline: none;
    }
    input:focus { border-color: #6366f1; }
    button {
      width: 100%; margin-top: 18px; border: 0; border-radius: 8px; padding: 10px 12px;
      background: #6366f1; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer;
    }
    .err {
      margin: 0 0 14px; padding: 8px 10px; border-radius: 8px;
      background: rgba(248,113,113,.12); color: #fca5a5; font-size: 13px;
    }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>shin-watcher</h1>
    <p>Sign in to access the dashboard.</p>
    ${err}
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" autofocus />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

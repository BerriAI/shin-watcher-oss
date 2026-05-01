import express, { type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { LiveBus, type LiveEvent } from "./live.js";
import type { Runner } from "../runner.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, "ui");

// Track whether a run is currently queued/running to prevent double-invocation.
let runInProgress = false;
// Hold the current agent so we can abort it.
let currentTaskId: string | null = null;

export function startDashboard(runner: Runner, port = 3333): void {
  const app = express();
  app.use(express.json());
  app.use("/ui", express.static(UI_DIR));

  // ── Pages ──────────────────────────────────────────────────────────────────

  app.get("/", (_req, res) => res.sendFile(path.join(UI_DIR, "chat.html")));

  // ── API: status ────────────────────────────────────────────────────────────

  app.get("/api/status", (_req, res) => {
    const active = LiveBus.getActiveRuns();
    res.json({
      busy: runInProgress,
      currentTaskId,
      active: active.map((r) => ({
        taskId: r.taskId,
        issueNumber: r.issue.number,
        issueTitle: r.issue.title,
        issueUrl: r.issue.htmlUrl,
        startedAt: r.startedAt,
      })),
    });
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

    const onEvent = (live: LiveEvent) => send({ ...live.event, taskId: live.taskId });
    const onStart = (payload: object) => send({ type: "run_start", ...payload });
    const onEnd = (payload: object) => send({ type: "run_end", ...payload });

    LiveBus.on("agent_event", onEvent);
    LiveBus.on("run_start", onStart);
    LiveBus.on("run_end", onEnd);

    const cleanup = () => {
      LiveBus.off("agent_event", onEvent);
      LiveBus.off("run_start", onStart);
      LiveBus.off("run_end", onEnd);
    };
    req.on("close", cleanup);
  });

  // ── POST: invoke ──────────────────────────────────────────────────────────

  app.post("/api/invoke", async (req, res) => {
    const { command } = req.body as { command?: string };
    if (!command?.trim()) return res.status(400).json({ error: "command required" });

    if (runInProgress) {
      return res.json({
        queued: false,
        message: "A run is already in progress. Use /api/interrupt to stop it first.",
      });
    }

    const issueNumber = parseIssueNumber(command.trim());
    const runNext = !issueNumber && /next/i.test(command);
    const fix = /\bfix\b/i.test(command);

    if (issueNumber === null && !runNext) {
      return res.json({
        queued: false,
        message: `Didn't understand that. Try:\n  run #12345\n  run next\n  run #12345 fix\n  Or paste a GitHub issue URL.`,
      });
    }

    res.json({ queued: true, issueNumber: issueNumber ?? null });

    setImmediate(async () => {
      runInProgress = true;
      if (fix) process.env["AUTO_FIX"] = "true";
      try {
        await runner.runOne(issueNumber ?? undefined);
      } catch (e) {
        console.error("[dashboard] invoke error:", e);
      } finally {
        runInProgress = false;
        if (fix) delete process.env["AUTO_FIX"];
      }
    });
  });

  // ── POST: interrupt ───────────────────────────────────────────────────────

  app.post("/api/interrupt", (_req, res) => {
    const active = LiveBus.getActiveRuns();
    if (active.length === 0) {
      return res.json({ ok: false, message: "No active run to interrupt." });
    }
    for (const run of active) {
      run.agent.abort();
    }
    res.json({ ok: true, interrupted: active.map((r) => r.taskId) });
  });

  // ── POST: steer (inject mid-run message) ─────────────────────────────────

  app.post("/api/steer", async (req, res) => {
    const { message } = req.body as { message?: string };
    if (!message?.trim()) return res.status(400).json({ error: "message required" });

    const active = LiveBus.getActiveRuns();
    if (active.length === 0) {
      return res.status(410).json({ error: "No active run to steer." });
    }

    const run = active[0]!;
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

  app.listen(port, () => {
    console.log(`\n  Dashboard  →  http://localhost:${port}\n`);
  });
}

// Parse a GitHub issue number from various input formats:
//   #12345 | 12345 | https://github.com/BerriAI/litellm/issues/12345 | run #12345
function parseIssueNumber(input: string): number | null {
  // GitHub URL
  const urlMatch = input.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1] as string, 10);
  // #number or plain number
  const numMatch = input.match(/#?(\d+)/);
  if (numMatch) return parseInt(numMatch[1] as string, 10);
  return null;
}

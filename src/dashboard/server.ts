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

// Holds a steer message to inject once a new run's agent becomes available.
const pendingSteer = new Map<string, string>();

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
      busy: active.length > 0,
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
  // Accepts: issue number, GitHub URL, "next", or any freeform text.
  // Freeform text → picks next eligible issue and steers the agent with the message.

  app.post("/api/invoke", async (req, res) => {
    const { command, steerMessage } = req.body as { command?: string; steerMessage?: string };
    const raw = (command ?? "").trim();

    // Parse issue number from URL or #N notation
    const issueNumber = parseIssueNumber(raw);
    const fix = /\bfix\b/i.test(raw);

    res.json({ queued: true, issueNumber: issueNumber ?? null });

    setImmediate(async () => {
      if (fix) process.env["AUTO_FIX"] = "true";
      try {
        // If a freeform steer message was included, inject it once the agent starts.
        // We hook into run_start to find the taskId, then steer.
        if (steerMessage) {
          const onStart = (payload: { taskId: string }) => {
            LiveBus.off("run_start", onStart);
            setTimeout(() => {
              const agent = LiveBus.getAgent(payload.taskId);
              if (agent) agent.prompt(steerMessage).catch(() => {});
            }, 2000); // small delay so agent has initialized
          };
          LiveBus.on("run_start", onStart);
        }
        await runner.runOne(issueNumber ?? undefined);
      } catch (e) {
        console.error("[dashboard] invoke error:", e);
      } finally {
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

import fs from "node:fs";
import path from "node:path";
import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type BeforeToolCallContext,
} from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { loadProfile, type Profile } from "../profile.js";
import { buildLiteLlmModel, getLiteLlmApiKey } from "../model.js";
import { makeShellTool } from "../tools/shell.js";
import { makeCurlTool } from "../tools/curl.js";
import { makeStitchGifTool } from "../tools/screenshot.js";
import {
  makeWriteReportTool,
  type ReportPayload,
} from "../tools/writeReport.js";
import { makeBeginReproRunTool } from "../tools/beginReproRun.js";
import { McpBridge } from "../mcp/bridge.js";
import { githubMcpServer, playwrightMcpServer } from "../mcp/servers.js";
import { buildRootSystemPrompt } from "../prompts/root.js";
import { LiveBus } from "./live.js";
import { State } from "../state.js";
import { feedbackTools } from "self-improving-agent/pi";

/** How long (ms) a session can be idle before auto-disposal. */
const SESSION_TTL_MS = 30 * 60 * 1_000; // 30 min

/** GitHub tools that mutate state — blocked unless autoFix is on. */
const GITHUB_WRITE_TOOLS = new Set([
  "github_create_pull_request",
  "github_create_or_update_file",
  "github_push_files",
  "github_create_branch",
  "github_merge_pull_request",
  "github_update_pull_request_branch",
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_comment",
]);

export interface RootSession {
  sessionId: string;
  agent: Agent;
  /**
   * The taskId of the currently active repro run, or null when idle.
   * Set by begin_repro_run, cleared by write_report.
   */
  currentTaskId: string | null;
  /**
   * Stable Langfuse session identifier for THIS chat — derived from the
   * "This is issue #XXX" / "This is a pasted issue: ..." declaration the
   * agent emits on Turn 1 (per BerriAI/shin-watcher-oss#2). Null until
   * the first Turn 1 reply has been parsed. Once set, every subsequent
   * trace from this chat is tagged with the same sessionId so the whole
   * conversation lands in one Langfuse session.
   */
  issueId: string | null;
  lastActivityAt: number;
  dispose: () => Promise<void>;
}

class SessionManagerImpl {
  private sessions = new Map<string, RootSession>();
  private state = new State(config.paths.stateDb);
  private profile: Profile = loadProfile(config.profile);
  private gcInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Garbage-collect idle sessions every 5 minutes.
    this.gcInterval = setInterval(() => this.gc(), 5 * 60_000).unref();
  }

  getOrCreate(sessionId: string): RootSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    const session = this.create(sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  destroy(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.dispose().catch(console.error);
      this.sessions.delete(sessionId);
    }
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > SESSION_TTL_MS && !session.currentTaskId) {
        console.log(`[session] gc: disposing idle session ${id}`);
        session.dispose().catch(console.error);
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Build and wire up a new root agent for one chat tab.
   *
   * The session owns:
   *  - MCP bridge (Playwright + GitHub) — lives for the full session
   *  - shell tool rooted at config.paths.workdir
   *  - begin_repro_run tool — creates run dir, registers with LiveBus
   *  - write_report tool   — records attempt, signals LiveBus.endRun
   */
  private create(sessionId: string): RootSession {
    // Mutable reference — updated by tool callbacks without closing over stale session.
    const sessionRef: { obj: RootSession | null } = { obj: null };

    // Per-session Playwright screenshot dir (shared across repro runs in this session).
    const screenshotBaseDir = path.join(
      config.paths.screenshots,
      `session-${sessionId.slice(0, 12)}`
    );
    fs.mkdirSync(screenshotBaseDir, { recursive: true });

    // Transcript for this session.
    const transcriptPath = path.join(
      config.paths.runs,
      `session-${sessionId.slice(0, 12)}`,
      "root-transcript.jsonl"
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const transcriptStream = fs.createWriteStream(transcriptPath, { flags: "a" });

    // MCP bridge — spawned once per session.
    const bridge = new McpBridge();

    const buildAgent = async (): Promise<Agent> => {
      const [browserTools, githubTools] = await Promise.all([
        bridge.connect(playwrightMcpServer({ outputDir: screenshotBaseDir })),
        bridge.connect(githubMcpServer()),
      ]);

      // Placeholder reportPath — root write_report uses task_id to resolve actual path.
      const placeholderReportPath = path.join(config.paths.runs, "_placeholder", "report.md");

      const nativeTools: AgentTool[] = [
        makeShellTool({ rootDir: config.paths.workdir }) as AgentTool,
        makeCurlTool() as AgentTool,
        makeStitchGifTool() as AgentTool,
        makeBeginReproRunTool({
          profile: this.profile,
          chatSessionId: sessionId,
          onBegin: (taskId, workdir, proxyPort) => {
            const s = sessionRef.obj;
            if (s) {
              s.currentTaskId = taskId;
              console.log(
                `[session:${sessionId.slice(0, 8)}] repro started: taskId=${taskId} port=${proxyPort} workdir=${workdir}`
              );
            }
          },
        }) as AgentTool,
        makeWriteReportTool({
          reportPath: placeholderReportPath,
          onReport: (payload: ReportPayload, taskId?: string) => {
            const s = sessionRef.obj;
            const resolvedTaskId = taskId ?? s?.currentTaskId ?? undefined;

            if (resolvedTaskId) {
              LiveBus.endRun(resolvedTaskId, payload.verdict, payload.verdict_reasoning);
            }
            if (s) s.currentTaskId = null;

            const issueNumber = resolvedTaskId
              ? extractIssueNumber(resolvedTaskId)
              : null;

            if (issueNumber != null) {
              try {
                this.state.recordAttempt({
                  issueNumber,
                  verdict: payload.verdict,
                  difficulty: payload.difficulty,
                  reportPath: resolvedTaskId
                    ? path.join(config.paths.runs, resolvedTaskId, "report.md")
                    : placeholderReportPath,
                  prUrl: payload.pr_url ?? null,
                  durationMs: 0,
                  errorMessage: null,
                });
              } catch (e) {
                console.error("[session] state.recordAttempt error:", e);
              }
            }

            console.log(
              `[session:${sessionId.slice(0, 8)}] repro finished: taskId=${resolvedTaskId} verdict=${payload.verdict}`
            );
          },
        }) as AgentTool,
      ];

      // self-improving-agent: lets the root agent propose diffs to its own
      // prompts/tools when the user gives feedback in chat, then open a draft
      // PR after explicit approval. SELF_IMPROVING_AGENT_REPO_ROOT must point
      // at this repo (see .env.example).
      const tools = [
        ...nativeTools,
        ...browserTools,
        ...githubTools,
        ...feedbackTools,
      ];

      const canOpenAnotherPrToday = () =>
        this.state.countFixPrsToday() < config.flags.maxFixPrsPerDay;

      const beforeToolCall = async (
        ctx: BeforeToolCallContext
      ): Promise<{ block?: boolean; reason?: string } | undefined> => {
        if (GITHUB_WRITE_TOOLS.has(ctx.toolCall.name)) {
          if (!config.flags.autoFix) {
            return {
              block: true,
              reason:
                "AUTO_FIX is disabled. Do not push code, open PRs, or post comments. " +
                "Write the structured report only.",
            };
          }
          if (!canOpenAnotherPrToday()) {
            return {
              block: true,
              reason:
                "Daily PR cap hit. Do not open more PRs or post more comments today. " +
                "Finish by calling write_report with what you've found.",
            };
          }
        }
        return undefined;
      };

      const agent = new Agent({
        initialState: {
          systemPrompt: buildRootSystemPrompt(this.profile),
          model: buildLiteLlmModel(),
          thinkingLevel: "high",
          tools,
          messages: [] as Message[],
        },
        convertToLlm: (messages) =>
          messages.filter((m) =>
            ["user", "assistant", "toolResult"].includes(
              (m as { role?: string }).role ?? ""
            )
          ) as Message[],
        getApiKey: () => getLiteLlmApiKey(),
        beforeToolCall,
        toolExecution: "sequential",
        sessionId,
      });

      // Log all events to the session transcript.
      agent.subscribe(async (event: AgentEvent) => {
        try {
          transcriptStream.write(JSON.stringify({ ts: Date.now(), ...event }) + "\n");
        } catch {
          /* swallow */
        }

        // Route events to LiveBus when a repro run is active.
        const s = sessionRef.obj;
        if (s?.currentTaskId) {
          LiveBus.pushEvent(s.currentTaskId, event);
        }
      });

      return agent;
    };

    // Build synchronously for simple interface — we'll await the promise in getOrCreate.
    // The agent resolves on first use via the lazy pattern below.
    let agentPromise: Promise<Agent> | null = null;
    let resolvedAgent: Agent | null = null;

    const getAgent = (): Promise<Agent> => {
      if (resolvedAgent) return Promise.resolve(resolvedAgent);
      if (!agentPromise) {
        agentPromise = buildAgent().then((a) => {
          resolvedAgent = a;
          return a;
        }).catch((e) => {
          // Clear so the next call retries rather than returning a forever-rejected promise.
          agentPromise = null;
          throw e;
        });
      }
      return agentPromise;
    };

    // Proxy agent object that defers to the resolved agent.
    // We need a real Agent reference for server.ts subscribe calls,
    // so we eagerly build and store it.
    const session: RootSession = {
      sessionId,
      // Will be replaced once the agent resolves; server must await getAgent().
      agent: null as unknown as Agent,
      currentTaskId: null,
      issueId: null,
      lastActivityAt: Date.now(),
      dispose: async () => {
        try {
          transcriptStream.end();
        } catch {
          /* ignore */
        }
        try {
          await bridge.dispose();
        } catch {
          /* ignore */
        }
      },
    };
    sessionRef.obj = session;

    // Build the agent eagerly and patch it in once ready.
    getAgent()
      .then((a) => {
        session.agent = a;
      })
      .catch((e) => {
        console.error(`[session:${sessionId.slice(0, 8)}] agent build error:`, e);
      });

    return session;
  }
}

export const SessionManager = new SessionManagerImpl();

/**
 * Wait until the session's agent is fully initialised (MCP servers connected).
 * Returns the Agent. Throws on timeout.
 */
export async function awaitSessionAgent(
  session: RootSession,
  timeoutMs = 60_000
): Promise<Agent> {
  const deadline = Date.now() + timeoutMs;
  while (!session.agent) {
    if (Date.now() > deadline) {
      throw new Error("Session agent timed out waiting to initialise");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return session.agent;
}

function extractIssueNumber(taskId: string): number | null {
  const m = taskId.match(/__issue-(\d+)$/);
  return m ? parseInt(m[1] as string, 10) : null;
}

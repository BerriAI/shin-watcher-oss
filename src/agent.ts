import fs from "node:fs";
import path from "node:path";
import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type BeforeToolCallContext,
} from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { config } from "./config.js";
import { buildLiteLlmModel, getLiteLlmApiKey } from "./model.js";
import { makeShellTool } from "./tools/shell.js";
import { makeCurlTool } from "./tools/curl.js";
import { makeStitchGifTool } from "./tools/screenshot.js";
import {
  makeWriteReportTool,
  type ReportPayload,
} from "./tools/writeReport.js";
import { McpBridge } from "./mcp/bridge.js";
import { githubMcpServer, playwrightMcpServer } from "./mcp/servers.js";

export interface AgentBundle {
  agent: Agent;
  /** Resolves with the final structured report once the agent calls `write_report`. */
  reportPromise: Promise<ReportPayload>;
  transcriptPath: string;
  /** Tear down: closes MCP subprocesses + the transcript stream. ALWAYS call in finally. */
  dispose: () => Promise<void>;
}

export interface CreateAgentOptions {
  /** Working directory the shell tool is sandboxed into (the litellm clone). */
  rootDir: string;
  /** Where Playwright MCP writes screenshots and where stitch_gif puts the GIF. */
  screenshotDir: string;
  /** Stable identifier for this run; used as session id. */
  taskId: string;
  /** Path the agent must write report.md to (via write_report tool). */
  reportPath: string;
  /** Path to the JSONL transcript log. */
  transcriptPath: string;
  /** System prompt (built by prompts/repro.ts). */
  systemPrompt: string;
  /** Optional pre-existing transcript to continue from. */
  initialMessages?: Message[];
  /** When true, expose write-capable GitHub MCP tools and tell the agent it may push + open PRs. */
  fixEnabled: boolean;
  /** Predicate the cap-enforcement hook calls before allowing PR-opening tools. */
  canOpenPrToday: () => boolean;
}

/**
 * Tool names that mutate GitHub. The beforeToolCall hook blocks all of these
 * when the daily PR cap is hit, so the agent can't bypass our limits.
 *
 * This is the safety boundary that lets us hand the agent GitHub MCP at all.
 */
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

/**
 * Build a fully-wired Agent for one issue.
 *
 * Tool inventory (approximate — varies by MCP server version):
 *   shell                   — bounded subprocess inside rootDir
 *   curl                    — localhost-only HTTP
 *   stitch_gif              — ImageMagick PNG → animated GIF
 *   browser_*               — Playwright MCP (snapshot, click, type, take_screenshot, …)
 *   github_*                — GitHub MCP (fork_repository, create_pull_request, add_issue_comment, …)
 *   write_report            — MANDATORY FINAL TOOL
 *
 * All LLM calls flow through pi-ai → the LiteLLM proxy at config.litellm.baseUrl.
 */
export async function createAgent(opts: CreateAgentOptions): Promise<AgentBundle> {
  fs.mkdirSync(path.dirname(opts.transcriptPath), { recursive: true });
  fs.mkdirSync(opts.screenshotDir, { recursive: true });
  const transcriptStream = fs.createWriteStream(opts.transcriptPath, {
    flags: "a",
  });

  // 1. Bring up MCP servers in parallel — they're slow to spawn (`npx -y`).
  const bridge = new McpBridge();
  const [browserTools, githubTools] = await Promise.all([
    bridge.connect(playwrightMcpServer({ outputDir: opts.screenshotDir })),
    bridge.connect(githubMcpServer()),
  ]);

  // 2. Native (non-MCP) tools that we own.
  let resolveReport!: (p: ReportPayload) => void;
  let rejectReport!: (e: Error) => void;
  const reportPromise = new Promise<ReportPayload>((res, rej) => {
    resolveReport = res;
    rejectReport = rej;
  });
  const nativeTools: AgentTool[] = [
    makeShellTool({ rootDir: opts.rootDir }) as AgentTool,
    makeCurlTool() as AgentTool,
    makeStitchGifTool() as AgentTool,
    makeWriteReportTool({
      reportPath: opts.reportPath,
      onReport: (p) => resolveReport(p),
    }) as AgentTool,
  ];

  const tools: AgentTool[] = [...nativeTools, ...browserTools, ...githubTools];

  // 3. The cap-enforcement hook. This is the single safety boundary that lets
  //    us safely give the agent GitHub MCP write tools.
  const beforeToolCall = async (
    ctx: BeforeToolCallContext
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    if (GITHUB_WRITE_TOOLS.has(ctx.toolCall.name)) {
      if (!opts.fixEnabled) {
        return {
          block: true,
          reason:
            "AUTO_FIX is disabled for this run. Do not push code, open PRs, or post comments. " +
            "Write the structured report only.",
        };
      }
      if (!opts.canOpenPrToday()) {
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

  // 4. Construct the agent.
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: buildLiteLlmModel(),
      thinkingLevel: "high",
      tools,
      messages: opts.initialMessages ?? [],
    },
    convertToLlm: (messages) =>
      messages.filter((m) =>
        ["user", "assistant", "toolResult"].includes(
          (m as { role?: string }).role ?? ""
        )
      ) as Message[],
    getApiKey: () => getLiteLlmApiKey(),
    beforeToolCall,
    toolExecution: "sequential", // browser + git mutations don't tolerate races
    sessionId: opts.taskId,
  });

  // 5. Stream every event to the transcript log for postmortem inspection.
  agent.subscribe(async (event: AgentEvent) => {
    try {
      transcriptStream.write(JSON.stringify({ ts: Date.now(), ...event }) + "\n");
    } catch {
      /* swallow */
    }
  });

  return {
    agent,
    reportPromise,
    transcriptPath: opts.transcriptPath,
    dispose: async () => {
      // Surface "agent ended without write_report" as a rejection if the report
      // promise hasn't already settled.
      reportPromise.catch(() => {}); // make sure no unhandled rejection
      try {
        rejectReport(new Error("agent ended without calling write_report"));
      } catch {
        /* already settled */
      }
      try {
        await bridge.dispose();
      } catch {
        /* ignore */
      }
      try {
        transcriptStream.end();
      } catch {
        /* already closed */
      }
    },
  };
}

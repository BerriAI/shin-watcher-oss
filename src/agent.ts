import fs from "node:fs";
import path from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { config } from "./config.js";
import { buildLiteLlmModel, getLiteLlmApiKey } from "./model.js";
import { makeShellTool } from "./tools/shell.js";
import { makeCurlTool } from "./tools/curl.js";
import { BrowserSession, makeBrowserTools } from "./tools/browser.js";
import { makeScreenshotTools } from "./tools/screenshot.js";
import {
  makeWriteReportTool,
  type ReportPayload,
} from "./tools/writeReport.js";

export interface AgentBundle {
  agent: Agent;
  browser: BrowserSession;
  /** Resolves with the final report payload once `write_report` is called. */
  reportPromise: Promise<ReportPayload>;
  /** Path to the JSONL transcript log being written for this run. */
  transcriptPath: string;
  /** Cleanly tear down the browser + flush logs. Call this in a finally block. */
  dispose: () => Promise<void>;
}

export interface CreateAgentOptions {
  /** Working directory the shell tool is sandboxed into (the litellm clone). */
  rootDir: string;
  /** Where to put screenshots + the stitched GIF. */
  screenshotDir: string;
  /** Stable identifier for this run; becomes part of screenshot filenames. */
  taskId: string;
  /** Path the agent must write its final report.md to. */
  reportPath: string;
  /** Path to the JSONL transcript log. */
  transcriptPath: string;
  /** System prompt (built by prompts/repro.ts or prompts/fix.ts). */
  systemPrompt: string;
  /** Optional pre-existing transcript to continue from. */
  initialMessages?: Message[];
}

/**
 * Build a fully-wired Agent for one phase of one issue.
 *
 * The agent has these tools:
 *   - shell        — bounded subprocess inside rootDir
 *   - curl         — localhost-only HTTP
 *   - browser_*    — Playwright (navigate/click/fill/screenshot/eval)
 *   - list_screenshots, stitch_gif — file inventory + GIF assembly
 *   - write_report — MUST be called exactly once at the end
 *
 * All LLM calls flow through pi-ai → the litellm proxy at config.litellm.baseUrl.
 */
export function createAgent(opts: CreateAgentOptions): AgentBundle {
  fs.mkdirSync(path.dirname(opts.transcriptPath), { recursive: true });
  const transcriptStream = fs.createWriteStream(opts.transcriptPath, {
    flags: "a",
  });

  const browser = new BrowserSession(opts.screenshotDir, opts.taskId);

  let resolveReport!: (p: ReportPayload) => void;
  let rejectReport!: (e: Error) => void;
  const reportPromise = new Promise<ReportPayload>((res, rej) => {
    resolveReport = res;
    rejectReport = rej;
  });

  const tools: AgentTool[] = [
    makeShellTool({ rootDir: opts.rootDir }) as AgentTool,
    makeCurlTool() as AgentTool,
    ...makeBrowserTools(browser),
    ...makeScreenshotTools({ screenshotDir: opts.screenshotDir }),
    makeWriteReportTool({
      reportPath: opts.reportPath,
      onReport: (p) => resolveReport(p),
    }) as AgentTool,
  ];

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: buildLiteLlmModel(),
      thinkingLevel: "high",
      tools,
      messages: opts.initialMessages ?? [],
    },
    // Default convertToLlm: pass through anything that's already an LLM-compatible
    // message (user/assistant/toolResult). Filter out anything else (we don't use
    // custom message types).
    convertToLlm: (messages) =>
      messages.filter((m) =>
        ["user", "assistant", "toolResult"].includes((m as { role?: string }).role ?? "")
      ) as Message[],
    getApiKey: () => getLiteLlmApiKey(),
    toolExecution: "sequential", // browser state means we don't want races
    sessionId: opts.taskId,
  });

  // Stream every event to the transcript log for postmortem inspection.
  agent.subscribe(async (event: AgentEvent) => {
    try {
      transcriptStream.write(JSON.stringify({ ts: Date.now(), ...event }) + "\n");
    } catch {
      /* swallow */
    }
  });

  return {
    agent,
    browser,
    reportPromise,
    transcriptPath: opts.transcriptPath,
    dispose: async () => {
      // If the agent finished without calling write_report, surface that.
      reportPromise.catch(() => {}); // ensure no unhandled rejection
      try {
        rejectReport(new Error("agent ended without calling write_report"));
      } catch {
        /* already settled */
      }
      await browser.close();
      try {
        transcriptStream.end();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Convenience for tests / debugging. */
export function describeWiring(): string {
  return [
    `LiteLLM base URL : ${config.litellm.baseUrl}`,
    `LiteLLM model id : ${config.litellm.modelId}`,
    `Tools            : shell, curl, browser_*, list_screenshots, stitch_gif, write_report`,
  ].join("\n");
}

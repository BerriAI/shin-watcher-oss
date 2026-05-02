import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { config } from "../config.js";
import { LiveBus } from "../dashboard/live.js";
import type { CandidateIssue } from "../picker.js";

let portCounter = config.proxy.port;

const BeginReproParams = Type.Object({
  issue_number: Type.Number({
    description: "GitHub issue number to reproduce.",
  }),
  issue_title: Type.Optional(
    Type.String({ description: "Issue title (for dashboard display)." })
  ),
  issue_url: Type.Optional(
    Type.String({ description: "Full GitHub issue URL." })
  ),
  plan_summary: Type.Optional(
    Type.String({
      description:
        "1–3 sentence public summary of your understanding and initial repro plan. Shown to the user immediately.",
    })
  ),
});

export type BeginReproCallback = (taskId: string, workdir: string, proxyPort: number) => void;

/**
 * Thin utility tool the root agent calls once before any repro work.
 * Creates run/screenshot directories, allocates a proxy port, and
 * emits run_start + run_plan to LiveBus so the UI shows an immediate
 * issue readout before any cloning starts.
 */
export function makeBeginReproRunTool(opts: {
  chatSessionId?: string;
  onBegin: BeginReproCallback;
  onEndRun?: (taskId: string, verdict?: number, reasoning?: string) => void;
}): AgentTool<typeof BeginReproParams> {
  return {
    name: "begin_repro_run",
    label: "Begin Repro Run",
    description:
      "Call this FIRST before any repro work. Creates an isolated run directory, allocates a proxy port, and registers the run with the dashboard. " +
      "Returns taskId, workdir (clone litellm here), screenshotDir, reportPath, proxyPort, and proxy credentials. " +
      "Use taskId when naming screenshots (prefix every filename with taskId_). " +
      "Pass taskId to write_report when done.",
    parameters: BeginReproParams,
    execute: async (_id, params: Static<typeof BeginReproParams>) => {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const taskId = `${ts}__issue-${params.issue_number}`;
      const runDir = path.join(config.paths.runs, taskId);
      const screenshotDir = path.join(runDir, "screenshots");
      const workdir = path.join(config.paths.workdir, taskId, "litellm");
      const proxyPort = portCounter++;

      fs.mkdirSync(runDir, { recursive: true });
      fs.mkdirSync(screenshotDir, { recursive: true });
      fs.mkdirSync(path.dirname(workdir), { recursive: true });

      const issue: CandidateIssue = {
        number: params.issue_number,
        title: params.issue_title ?? `Issue #${params.issue_number}`,
        body: params.plan_summary ?? "",
        htmlUrl:
          params.issue_url ??
          `https://github.com/${config.github.targetOwner}/${config.github.targetRepo}/issues/${params.issue_number}`,
        author: "",
        labels: [],
        createdAt: new Date().toISOString(),
        recentComments: [],
      };

      LiveBus.beginRun(taskId, issue, opts.chatSessionId);
      if (params.plan_summary) {
        LiveBus.planRun(taskId, issue, opts.chatSessionId, params.plan_summary);
      }

      opts.onBegin(taskId, workdir, proxyPort);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                taskId,
                runDir,
                workdir,
                screenshotDir,
                reportPath: path.join(runDir, "report.md"),
                proxyPort,
                proxyMasterKey: config.proxy.masterKey,
                proxyUiUsername: config.proxy.uiUsername,
                proxyUiPassword: config.proxy.uiPassword,
                sandboxDbUrl: config.proxy.sandboxDbUrl || null,
                cloneUrl: `https://github.com/${config.github.targetOwner}/${config.github.targetRepo}.git`,
              },
              null,
              2
            ),
          },
        ],
        details: { taskId, runDir, proxyPort },
      };
    },
  };
}

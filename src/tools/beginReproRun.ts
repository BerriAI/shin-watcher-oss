import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { config } from "../config.js";
import { LiveBus } from "../dashboard/live.js";
import type { CandidateIssue } from "../picker.js";
import { generateProxyCredentials, SANDBOX_PROXY_PORT_START } from "../proxy.js";

let portCounter = SANDBOX_PROXY_PORT_START;

const BeginReproParams = Type.Object({
  issue_number: Type.Optional(
    Type.Number({
      description:
        "GitHub issue number to reproduce. Omit for a free-form issue pasted directly into chat.",
    })
  ),
  issue_title: Type.Optional(
    Type.String({ description: "Issue title (for dashboard display)." })
  ),
  issue_url: Type.Optional(
    Type.String({ description: "Full GitHub issue URL." })
  ),
  issue_body: Type.Optional(
    Type.String({
      description:
        "Free-form issue description pasted by the user. Use when there is no GitHub issue URL/number.",
    })
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
      const hasGithubIssue = typeof params.issue_number === "number";
      const title = params.issue_title ?? (hasGithubIssue ? `Issue #${params.issue_number}` : "Chat issue");
      const syntheticNumber = params.issue_number ?? 0;
      const taskId = hasGithubIssue
        ? `${ts}__issue-${params.issue_number}`
        : `${ts}__chat-issue`;
      const runDir = path.join(config.paths.runs, taskId);
      const screenshotDir = path.join(runDir, "screenshots");
      const workdir = path.join(config.paths.workdir, taskId, "litellm");
      const proxyPort = portCounter++;
      const proxyCreds = generateProxyCredentials();

      fs.mkdirSync(runDir, { recursive: true });
      fs.mkdirSync(screenshotDir, { recursive: true });
      fs.mkdirSync(path.dirname(workdir), { recursive: true });

      const issue: CandidateIssue = {
        number: syntheticNumber,
        title,
        body: params.issue_body ?? params.plan_summary ?? "",
        htmlUrl:
          params.issue_url ??
          (hasGithubIssue
            ? `https://github.com/${config.github.targetOwner}/${config.github.targetRepo}/issues/${params.issue_number}`
            : ""),
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
                proxyMasterKey: proxyCreds.masterKey,
                proxyUiUsername: proxyCreds.uiUsername,
                proxyUiPassword: proxyCreds.uiPassword,
                sandboxDbUrl: process.env["LITELLM_SANDBOX_DB_URL"] || null,
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

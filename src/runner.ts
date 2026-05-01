import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "./config.js";
import { State } from "./state.js";
import { Picker, type CandidateIssue } from "./picker.js";
import { prepareWorkdir, startProxy, type ProxyHandle } from "./proxy.js";
import { createAgent, type AgentBundle } from "./agent.js";
import { buildReproSystemPrompt, buildReproUserPrompt } from "./prompts/repro.js";
import { GitHubClient } from "./github.js";
import { buildIssueComment, summarizeRun, type RunSummary } from "./report.js";
import type { ReportPayload } from "./tools/writeReport.js";

export class Runner {
  private state: State;
  private picker: Picker;
  private github: GitHubClient;

  constructor() {
    this.state = new State(config.paths.stateDb);
    this.picker = new Picker(
      config.github.token,
      config.github.targetOwner,
      config.github.targetRepo,
      this.state
    );
    this.github = new GitHubClient();
  }

  async runOne(issueNumber?: number): Promise<RunSummary | null> {
    const issue = issueNumber
      ? await this.picker.fetchOne(issueNumber)
      : await this.picker.pickNext();
    if (!issue) {
      console.log("[runner] no eligible issue found");
      return null;
    }
    console.log(
      `[runner] picked #${issue.number}: ${issue.title} (${issue.htmlUrl})`
    );

    return this.runForIssue(issue);
  }

  private async runForIssue(issue: CandidateIssue): Promise<RunSummary> {
    const startedAt = Date.now();
    const taskId = makeTaskId(issue.number);
    const runDir = path.join(config.paths.runs, taskId);
    const screenshotDir = path.join(runDir, "screenshots");
    const reportPath = path.join(runDir, "report.md");
    const transcriptPath = path.join(runDir, "transcript.jsonl");
    const proxyLogPath = path.join(runDir, "proxy.log");
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(screenshotDir, { recursive: true });

    let proxy: ProxyHandle | null = null;
    let bundle: AgentBundle | null = null;
    const fixEnabled = this.shouldAttemptFix();
    let prUrl: string | null = null;
    let payload: ReportPayload | null = null;
    let errorMessage: string | null = null;

    const timeoutMs = config.schedule.maxRunMinutes * 60 * 1000;
    const timeoutHandle = setTimeout(() => {
      bundle?.agent.abort();
    }, timeoutMs);

    try {
      // 1. Prepare working tree (fresh checkout of origin/main).
      const workdir = prepareWorkdir({
        workdir: path.join(config.paths.workdir, "litellm"),
        ref: "main",
      });

      // 2. Start the local litellm proxy on :PROXY_PORT.
      proxy = await startProxy({
        workdir,
        port: config.proxy.port,
        masterKey: config.proxy.masterKey,
        uiUsername: config.proxy.uiUsername,
        uiPassword: config.proxy.uiPassword,
        databaseUrl: config.proxy.sandboxDbUrl || undefined,
        logPath: proxyLogPath,
      });

      // 3. Build the agent and prompt it.
      const systemPrompt = buildReproSystemPrompt({
        issue,
        workdir,
        screenshotDir,
        reportPath,
        taskId,
        fixEnabled,
      });
      bundle = createAgent({
        rootDir: workdir,
        screenshotDir,
        taskId,
        reportPath,
        transcriptPath,
        systemPrompt,
      });

      const userPrompt = buildReproUserPrompt(issue);
      const promptDone = bundle.agent.prompt(userPrompt);

      // Race: whichever resolves first wins. write_report sets `terminate: true`
      // which ends the loop, then `prompt()` resolves and `reportPromise` is set.
      payload = await Promise.race([
        bundle.reportPromise,
        promptDone.then(async () => {
          // If prompt finished without write_report, surface that as an error.
          throw new Error("agent finished without calling write_report");
        }),
      ]);
      // Wait for the agent to fully settle (drain any final events).
      await bundle.agent.waitForIdle().catch(() => undefined);

      // 4. If the agent applied a fix, push to the bot fork and open a draft PR.
      if (
        fixEnabled &&
        payload.fix_applied === true &&
        payload.verdict >= 3 &&
        payload.difficulty !== "hard"
      ) {
        if (!this.canOpenAnotherPrToday()) {
          console.log("[runner] daily PR cap hit; skipping PR open");
        } else if (this.diffWithinAutoFixBudget(workdir)) {
          const branch = `shin-watcher/issue-${issue.number}-${taskId.slice(-8)}`;
          const prBody = renderPrBody({
            issue,
            payload,
            screenshotDir,
            taskId,
          });
          try {
            prUrl = await this.github.pushBranchAndOpenDraftPr({
              workdir,
              branch,
              issueNumber: issue.number,
              issueTitle: issue.title,
              body: prBody,
            });
            this.state.recordOpenPr(prUrl, issue.number);
            console.log(`[runner] opened draft PR: ${prUrl}`);
          } catch (e) {
            errorMessage = `PR open failed: ${(e as Error).message}`;
            console.error(`[runner] ${errorMessage}`);
          }
        } else {
          console.log("[runner] diff exceeds auto-fix LOC budget; skipping PR");
        }
      }

      // 5. Optionally post a comment on the issue.
      if (config.flags.postComments) {
        const assetPaths = payload.screenshots.map((s) => s.path).filter(fs.existsSync);
        const hostedAssets = await this.github.uploadAssetsToGist(
          assetPaths,
          `shin-watcher run ${taskId} for #${issue.number}`
        );
        const comment = buildIssueComment({
          payload,
          hostedAssets,
          prUrl,
          taskId,
          reportArchiveUrl: null,
        });
        const commentUrl = await this.github.postIssueComment(issue.number, comment);
        if (commentUrl) console.log(`[runner] posted comment: ${commentUrl}`);
      } else {
        console.log("[runner] POST_COMMENTS=false — skipping issue comment");
      }
    } catch (e) {
      errorMessage = (e as Error).message;
      console.error(`[runner] error: ${errorMessage}`);
    } finally {
      clearTimeout(timeoutHandle);
      try {
        await proxy?.stop();
      } catch {
        /* ignore */
      }
      try {
        await bundle?.dispose();
      } catch {
        /* ignore */
      }
    }

    const summary = summarizeRun({
      issueNumber: issue.number,
      payload:
        payload ??
        // Fallback payload when the agent failed before calling write_report.
        ({
          verdict: 1,
          difficulty: "hard",
          verdict_reasoning: errorMessage ?? "agent did not produce a report",
          reproduction_steps: [],
          root_cause: [],
          fix_plan: [],
          success_criteria: [],
          screenshots: [],
        } as ReportPayload),
      reportPath,
      durationMs: Date.now() - startedAt,
      prUrl,
      errorMessage,
    });

    this.state.recordAttempt({
      issueNumber: summary.issueNumber,
      verdict: summary.verdict,
      difficulty: summary.difficulty,
      reportPath: summary.reportPath,
      prUrl: summary.prUrl,
      durationMs: summary.durationMs,
      errorMessage: summary.errorMessage,
    });

    console.log(
      `[runner] done #${issue.number} verdict=${summary.verdict} difficulty=${summary.difficulty} ` +
        `pr=${summary.prUrl ?? "none"} duration=${(summary.durationMs / 1000).toFixed(1)}s`
    );
    return summary;
  }

  close(): void {
    this.state.close();
  }

  private shouldAttemptFix(): boolean {
    if (!config.flags.autoFix) return false;
    return this.canOpenAnotherPrToday();
  }

  private canOpenAnotherPrToday(): boolean {
    return this.state.countFixPrsToday() < config.flags.maxFixPrsPerDay;
  }

  /**
   * Hard runtime gate: even if the agent self-classifies easy/medium, refuse
   * to open a PR if the cumulative diff is bigger than 200 LOC.
   */
  private diffWithinAutoFixBudget(workdir: string): boolean {
    try {
      const out = execFileSync(
        "git",
        ["diff", "--shortstat", "HEAD"],
        { cwd: workdir, encoding: "utf-8" }
      );
      // e.g. " 3 files changed, 47 insertions(+), 12 deletions(-)"
      const ins = /(\d+) insertions?/.exec(out);
      const del = /(\d+) deletions?/.exec(out);
      const total = (ins ? +ins[1]! : 0) + (del ? +del[1]! : 0);
      return total <= 200;
    } catch {
      return false;
    }
  }
}

function makeTaskId(issueNumber: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}__issue-${issueNumber}`;
}

function renderPrBody(args: {
  issue: CandidateIssue;
  payload: ReportPayload;
  screenshotDir: string;
  taskId: string;
}): string {
  const lines: string[] = [];
  lines.push(`Refs ${args.issue.htmlUrl}`);
  lines.push("");
  lines.push("> ⚠️ Auto-generated by **shin-watcher**. Requires human review before merge.");
  lines.push("");
  lines.push(`**Verdict:** ${args.payload.verdict}/5 · **Difficulty:** ${args.payload.difficulty}`);
  lines.push("");
  lines.push(args.payload.verdict_reasoning);
  lines.push("");
  lines.push("### Reproduction (validated against patched proxy in this PR)");
  args.payload.reproduction_steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("");
  lines.push("### Success criteria");
  for (const c of args.payload.success_criteria) {
    const box = c.validated ? "[x]" : "[ ]";
    lines.push(`- ${box} ${c.description}`);
  }
  lines.push("");
  lines.push(`<sub>shin-watcher run \`${args.taskId}\`</sub>`);
  return lines.join("\n");
}

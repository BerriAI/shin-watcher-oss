import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { State } from "./state.js";
import { Picker, type CandidateIssue } from "./picker.js";
import { prepareWorkdir, startProxy, type ProxyHandle } from "./proxy.js";
import { createAgent, type AgentBundle } from "./agent.js";
import {
  buildReproSystemPrompt,
  buildReproUserPrompt,
} from "./prompts/repro.js";
import { ensureBotRemote, ensureFork } from "./github.js";
import { summarizeRun, type RunSummary } from "./report.js";
import type { ReportPayload } from "./tools/writeReport.js";
import { LiveBus } from "./dashboard/live.js";

/**
 * Runner: owns scheduling-adjacent concerns.
 *
 *   - issue selection + cooldowns          → picker + state
 *   - working tree management              → proxy.prepareWorkdir
 *   - litellm proxy lifecycle              → proxy.startProxy
 *   - bot fork existence + git remote      → github.ensureFork / ensureBotRemote
 *   - hard timeout                         → setTimeout + agent.abort()
 *   - state persistence + cooldowns        → state.recordAttempt
 *
 * Everything else — repro, fix, push, PR, comment — is the agent's job, driven
 * via Playwright MCP + GitHub MCP. The runner does NOT touch GitHub APIs
 * directly; it only sets up the conditions (fork exists, remote configured,
 * proxy is healthy) so the agent can do its job autonomously.
 */
export class Runner {
  private state: State;
  private picker: Picker;

  constructor() {
    this.state = new State(config.paths.stateDb);
    this.picker = new Picker(
      config.github.token,
      config.github.targetOwner,
      config.github.targetRepo,
      this.state
    );
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

  close(): void {
    this.state.close();
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
    const fixEnabled = config.flags.autoFix && this.canOpenAnotherPrToday();
    let payload: ReportPayload | null = null;
    let errorMessage: string | null = null;

    const timeoutMs = config.schedule.maxRunMinutes * 60 * 1000;
    const timeoutHandle = setTimeout(() => {
      console.warn(`[runner] hard timeout (${config.schedule.maxRunMinutes}m), aborting`);
      bundle?.agent.abort();
    }, timeoutMs);

    try {
      // 1. Prepare working tree (fresh checkout of origin/main).
      const workdir = prepareWorkdir({
        workdir: path.join(config.paths.workdir, "litellm"),
        ref: "main",
      });

      // 2. Make sure the bot fork exists and is configured as a git remote
      //    inside the workdir, so the agent can `git push shin-bot ...`.
      if (fixEnabled) {
        ensureFork();
        ensureBotRemote(workdir);
      }

      // 3. Start the local litellm proxy on :PROXY_PORT.
      proxy = await startProxy({
        workdir,
        port: config.proxy.port,
        masterKey: config.proxy.masterKey,
        uiUsername: config.proxy.uiUsername,
        uiPassword: config.proxy.uiPassword,
        databaseUrl: config.proxy.sandboxDbUrl || undefined,
        logPath: proxyLogPath,
      });

      // 4. Build and prompt the agent.
      const systemPrompt = buildReproSystemPrompt({
        issue,
        workdir,
        screenshotDir,
        reportPath,
        taskId,
        fixEnabled,
      });
      bundle = await createAgent({
        rootDir: workdir,
        screenshotDir,
        taskId,
        reportPath,
        transcriptPath,
        systemPrompt,
        fixEnabled,
        canOpenPrToday: () => this.canOpenAnotherPrToday(),
      });

      // Register with LiveBus so the dashboard can stream events in real-time.
      LiveBus.startRun(taskId, issue, bundle.agent);
      bundle.agent.subscribe((event) => LiveBus.pushEvent(taskId, event));

      const userPrompt = buildReproUserPrompt(issue);
      const promptDone = bundle.agent.prompt(userPrompt);

      // Race: write_report sets terminate:true and resolves reportPromise.
      // If prompt() returns first without write_report being called, surface that as an error.
      payload = await Promise.race([
        bundle.reportPromise,
        promptDone.then(async () => {
          throw new Error("agent finished without calling write_report");
        }),
      ]);
      await bundle.agent.waitForIdle().catch(() => undefined);

      // 5. If the agent claims it opened a PR, record it for the daily cap.
      //    The agent embeds pr_url in the structured report when it calls
      //    github_create_pull_request itself.
      if (payload.pr_url) {
        this.state.recordOpenPr(payload.pr_url, issue.number);
        console.log(`[runner] agent reported PR: ${payload.pr_url}`);
      }
    } catch (e) {
      errorMessage = (e as Error).message;
      console.error(`[runner] error: ${errorMessage}`);
    } finally {
      clearTimeout(timeoutHandle);
      LiveBus.endRun(taskId);
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
      prUrl: payload?.pr_url ?? null,
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

  private canOpenAnotherPrToday(): boolean {
    return this.state.countFixPrsToday() < config.flags.maxFixPrsPerDay;
  }
}

function makeTaskId(issueNumber: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}__issue-${issueNumber}`;
}

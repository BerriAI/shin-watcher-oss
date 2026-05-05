import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { loadProfile, type Profile } from "./profile.js";
import { State } from "./state.js";
import { Picker, type CandidateIssue } from "./picker.js";
import {
  generateProxyCredentials,
  prepareWorkdir,
  SANDBOX_PROXY_PORT_START,
  startProxy,
  type ProxyHandle,
} from "./proxy.js";
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
 *   - target service lifecycle             → proxy.startProxy
 *   - bot fork existence + git remote      → github.ensureFork / ensureBotRemote
 *   - hard timeout                         → setTimeout + agent.abort()
 *   - state persistence + cooldowns        → state.recordAttempt
 *
 * Everything else — repro, fix, push, PR, comment — is the agent's job, driven
 * via Playwright MCP + GitHub MCP. The runner does NOT touch GitHub APIs
 * directly; it only sets up the conditions (fork exists, remote configured,
 * proxy is healthy) so the agent can do its job autonomously.
 */
// Each concurrent run gets its own proxy port so they don't conflict.
let nextPort = SANDBOX_PROXY_PORT_START;
function allocatePort(): number { return nextPort++; }

export class Runner {
  private state: State;
  private picker: Picker;
  private profile: Profile;

  constructor() {
    this.profile = loadProfile(config.profile);
    this.state = new State(config.paths.stateDb);
    this.picker = new Picker(
      config.github.token,
      config.github.targetOwner,
      config.github.targetRepo,
      this.state
    );
  }

  async runOne(
    issueNumber?: number,
    opts?: { chatSessionId?: string }
  ): Promise<RunSummary | null> {
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
    return this.runForIssue(issue, opts);
  }

  close(): void {
    this.state.close();
  }

  private async runForIssue(
    issue: CandidateIssue,
    opts?: { chatSessionId?: string }
  ): Promise<RunSummary> {
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

    LiveBus.beginRun(taskId, issue, opts?.chatSessionId);
    LiveBus.planRun(taskId, issue, opts?.chatSessionId, buildInitialPublicPlan(issue));

    try {
      LiveBus.setupRun(taskId, issue, opts?.chatSessionId, "Preparing isolated worktree");
      // 1. Prepare working tree — each run gets its own isolated clone so
      //    concurrent runs don't clobber each other's git state.
      const workdir = await prepareWorkdir({
        workdir: path.join(config.paths.workdir, taskId, this.profile.name),
        profile: this.profile,
      });

      LiveBus.setupRun(taskId, issue, opts?.chatSessionId, "Checking GitHub fork / remotes");
      // 2. Make sure the bot fork exists and is configured as a git remote
      //    inside the workdir, so the agent can `git push shin-bot ...`.
      if (fixEnabled) {
        ensureFork();
        ensureBotRemote(workdir);
      }

      LiveBus.setupRun(
        taskId,
        issue,
        opts?.chatSessionId,
        `Starting local ${this.profile.name} service`
      );
      // 3. Start the target service on an allocated port (unique per run)
      //    with ephemeral admin credentials scoped to this run only.
      const proxyPort = allocatePort();
      const proxyCreds = generateProxyCredentials();
      proxy = await startProxy({
        workdir,
        port: proxyPort,
        profile: this.profile,
        masterKey: proxyCreds.masterKey,
        uiUsername: proxyCreds.uiUsername,
        uiPassword: proxyCreds.uiPassword,
        databaseUrl: process.env["LITELLM_SANDBOX_DB_URL"] || undefined,
        logPath: proxyLogPath,
        onRetry: (attempt, maxAttempts, shortError) => {
          LiveBus.setupRun(
            taskId,
            issue,
            opts?.chatSessionId,
            `Proxy not ready yet (attempt ${attempt}/${maxAttempts}): ${shortError} — retrying…`
          );
        },
      });

      LiveBus.setupRun(taskId, issue, opts?.chatSessionId, "Creating repro agent");
      // 4. Build and prompt the agent.
      const systemPrompt = buildReproSystemPrompt({
        issue,
        workdir,
        screenshotDir,
        reportPath,
        taskId,
        fixEnabled,
        profile: this.profile,
        proxyPort,
        proxyMasterKey: proxyCreds.masterKey,
        proxyUiUsername: proxyCreds.uiUsername,
        proxyUiPassword: proxyCreds.uiPassword,
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
      LiveBus.startRun(taskId, issue, bundle.agent, opts?.chatSessionId);
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
      if (!bundle) {
        LiveBus.setupError(taskId, issue, opts?.chatSessionId, errorMessage);
      }
    } finally {
      clearTimeout(timeoutHandle);
      LiveBus.endRun(taskId, payload?.verdict, payload?.verdict_reasoning);
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

function buildInitialPublicPlan(issue: CandidateIssue): string {
  const body = issue.body.replace(/\s+/g, " ").trim();
  const bodyHint = body.length > 260 ? `${body.slice(0, 260)}...` : body;
  return [
    `I have the issue loaded: **#${issue.number} ${issue.title}**.`,
    bodyHint ? `Initial read: ${bodyHint}` : "Initial read: the issue body is empty, so I will rely on the title and comments first.",
    "Plan: boot an isolated worktree of the target repo, start a local service, then use the repro agent to verify the reported behavior with API/browser evidence.",
    "Once the agent runtime is ready, it will stream its own observations and adjust the repro path from the actual results.",
  ].join("\n\n");
}

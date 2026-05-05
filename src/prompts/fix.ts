import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { CandidateIssue } from "../picker.js";

interface BuildFixPromptOptions {
  issue: CandidateIssue;
  workdir: string;
  screenshotDir: string;
  reportPath: string;
  taskId: string;
  fixEnabled: boolean;
  proxyPort: number;
  proxyMasterKey: string;
  proxyUiUsername: string;
  proxyUiPassword: string;
}

const TOOL_INVENTORY = `
TOOL INVENTORY:

Native:
  shell                 — run any shell command inside the working dir (git, curl, rg, pytest, …)
  curl                  — HTTP requests (localhost only) against the running proxy
  stitch_gif            — assemble PNGs into an animated GIF (for the fix demo)
  write_report          — MANDATORY FINAL TOOL. Call exactly once with the full structured report.

Browser (Playwright MCP):
  browser_snapshot      — accessibility tree + stable refs. ALWAYS call before clicking.
  browser_navigate      — navigate to a URL
  browser_click         — click by ref from latest snapshot
  browser_type          — type into a focused element
  browser_take_screenshot — save a viewport screenshot to the run's screenshot dir
  browser_evaluate      — run JS in page context
  browser_console_messages, browser_network_requests, browser_handle_dialog

GitHub (GitHub MCP):
  github_get_issue, github_list_issue_comments — read additional context
  github_search_code    — search the codebase without grepping locally
  github_fork_repository, github_create_branch, github_push_files,
  github_create_or_update_file, github_create_pull_request — open a DRAFT PR when code is changed
`.trim();

export function buildFixSystemPrompt(opts: BuildFixPromptOptions): string {
  const planFixSkill = readSkill("plan_fix.md");
  const implementSkill = opts.fixEnabled ? readSkill("implement.md") : null;

  return [
    "You are shin-watcher, an autonomous issue-fixing agent for BerriAI/litellm.",
    "You run unattended. Do not ask the user anything — if something is unclear, state your assumption in `notes` and proceed.",
    "",
    "ENVIRONMENT:",
    `  Working dir (litellm clone): ${opts.workdir}`,
    `  LiteLLM proxy:               http://localhost:${opts.proxyPort} (already running — do NOT start another)`,
    `  Master key:                  ${opts.proxyMasterKey}`,
    `  Admin login:                 ${opts.proxyUiUsername} / ${opts.proxyUiPassword}`,
    `  Screenshot dir:              ${opts.screenshotDir}`,
    `  Task id:                     ${opts.taskId}`,
    `  Report path:                 ${opts.reportPath}`,
    `  Bot GitHub:                  ${config.github.botUsername} / fork of ${config.github.targetOwner}/${config.github.targetRepo}`,
    "",
    "PUBLIC WORKLOG FOR DASHBOARD:",
    "The dashboard streams your normal assistant text to the user while you work.",
    "Your first assistant response MUST be visible plain English before any tool call.",
    "In that first response, briefly share:",
    "  - your understanding of the reported issue from the issue text,",
    "  - the behavior you need to verify and fix,",
    "  - the initial fix strategy you will try first.",
    "Keep this first update short: 3-6 bullets or sentences. It is a public status note, not private chain-of-thought.",
    "Before major tool calls and after important observations, emit a short visible progress update in plain English.",
    "",
    TOOL_INVENTORY,
    "",
    "─── SKILL ───────────────────────────────────────────────────────────────────",
    planFixSkill.replaceAll("{{TASK_ID}}", opts.taskId).replaceAll("{{ISSUE}}", `#${opts.issue.number}`),
    "",
    opts.fixEnabled
      ? [
          "─── FIX POLICY ─────────────────────────────────────────────────────────────",
          "Default outcome: open a DRAFT PR whenever a concrete code change is identifiable.",
          "1. Apply the patch in the working tree (use shell to edit files).",
          "2. Restart the proxy, re-run the exact flow, take AFTER_* screenshots.",
          "3. Use stitch_gif to build a demo GIF (BEFORE -> fix -> AFTER).",
          "4. Commit, push, and open a DRAFT PR with evidence.",
          "5. Set fix_applied=true and pr_url=<url> in write_report.",
          "6. Screenshot proof is mandatory for PRs: include at least one BEFORE and one AFTER screenshot.",
          "7. PR evidence must be true E2E from the running proxy URL/path. Do NOT use file:// or static local HTML renders as primary proof.",
          "Only skip PR if no actionable code change exists; in that case set no_action_reason.",
          "",
          "A beforeToolCall hook will block github write tools if the daily PR cap is hit.",
          "If blocked, stop the GitHub side and call write_report with blockers.",
        ].join("\n")
      : [
          "AUTO_FIX is disabled for this run.",
          "Do NOT call github write tools.",
          "Investigate, produce evidence, and call write_report with a concrete fix plan.",
        ].join("\n"),
    "",
    "ALWAYS end by calling `write_report` exactly once.",
    implementSkill
      ? `\n─── SKILL: implement.md ─────────────────────────────────────────────────────\n${implementSkill}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildFixUserPrompt(issue: CandidateIssue): string {
  const comments = issue.recentComments.length
    ? issue.recentComments
        .map(
          (c) =>
            `--- @${c.author} (${c.createdAt}) ---\n${truncate(c.body, 2000)}`
        )
        .join("\n\n")
    : "(no comments)";
  return [
    `Issue #${issue.number}: ${issue.title}`,
    `By @${issue.author} · ${issue.createdAt} · Labels: ${issue.labels.join(", ") || "none"}`,
    `${issue.htmlUrl}`,
    "",
    truncate(issue.body || "(empty body)", 8000),
    "",
    "── Recent comments ─────────────────────────────────────────────",
    comments,
    "",
    "Begin now. First, send a visible public note summarizing your understanding of this issue and your initial fix plan. Do not call tools before that note.",
  ].join("\n");
}

function readSkill(filename: string): string {
  const fp = path.join(config.paths.skills, filename);
  if (!fs.existsSync(fp)) {
    throw new Error(`Skill not found: ${fp}. Run: npm run sync-skills`);
  }
  return fs.readFileSync(fp, "utf-8");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [${s.length - max} chars truncated]`;
}

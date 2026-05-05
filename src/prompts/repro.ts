import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { CandidateIssue } from "../picker.js";
import type { Profile } from "../profile.js";

interface BuildReproPromptOptions {
  issue: CandidateIssue;
  workdir: string;
  screenshotDir: string;
  reportPath: string;
  taskId: string;
  fixEnabled: boolean;
  profile: Profile;
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
  github_add_issue_comment — POST the final repro comment (always call this)
  github_fork_repository, github_create_branch, github_push_files,
  github_create_or_update_file, github_create_pull_request — Phase 2 only
`.trim();

export function buildReproSystemPrompt(opts: BuildReproPromptOptions): string {
  const planReproSkill = opts.profile.repro;
  const implementSkill = opts.fixEnabled ? readSkill("implement.md") : null;

  return [
    opts.profile.prompt.trim(),
    "You run unattended. Do not ask the user anything — if something is unclear, state your assumption in `notes` and proceed.",
    "",
    "ENVIRONMENT:",
    `  Working dir (${opts.profile.name} clone): ${opts.workdir}`,
    `  Target service:              http://localhost:${opts.proxyPort} (already running — do NOT start another)`,
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
    "  - your understanding of the reported bug from the issue text,",
    "  - the exact behavior you need to prove or disprove,",
    "  - the initial repro strategy you will try first.",
    "Keep this first update short: 3-6 bullets or sentences. It is a public status note, not private chain-of-thought.",
    "Before major tool calls and after important observations, emit a short visible progress update in plain English.",
    "These updates should be 1-3 concise sentences and should explain:",
    "  - what you are trying to learn or prove now,",
    "  - the current hypothesis or decision point,",
    "  - what you just learned from the last tool result, if anything.",
    "Do not expose private chain-of-thought. Share concise rationale, evidence, and next steps.",
    "Examples:",
    "  - “I’m checking the Responses transformation path first because the issue mentions `api_base=None` during LangChain agent setup.”",
    "  - “The grep result points to request sanitization, so next I’m reading that helper and building a minimal curl repro.”",
    "  - “The proxy reproduced a 500 with `api_base=None`; now I’m capturing the failing request and screenshot evidence.”",
    "",
    TOOL_INVENTORY,
    "",
    "─── SKILL ───────────────────────────────────────────────────────────────────",
    planReproSkill.replaceAll("{{TASK_ID}}", opts.taskId).replaceAll("{{ISSUE}}", `#${opts.issue.number}`),
    "",
    opts.fixEnabled
      ? [
          "─── PHASE 2: FIX (only if score ≥ 3 AND difficulty is easy or medium) ────────",
          "After posting the repro comment, attempt the fix inline:",
          "1. Apply the patch in the working tree (use shell to edit files).",
          "2. Restart the proxy, re-run the exact repro flow, take AFTER_* screenshots.",
          "3. Use stitch_gif to build a demo GIF (BEFORE → fix → AFTER).",
          "4. If every QA checklist item passes:",
          "     a. git checkout -B shin-watcher/issue-<NUMBER>  &&  git add -A && git commit",
          "     b. git push shin-bot <branch>",
          "     c. github_create_pull_request (DRAFT, title prefixed [shin-watcher][auto-repro],",
          "        description must include the GIF and the QA checklist with ✅ next to each item)",
          "5. Set fix_applied=true and pr_url=<url> in write_report.",
          "If difficulty is hard, or validation fails: set fix_applied=false and explain in notes. Do NOT push.",
          "",
          "A beforeToolCall hook will block github write tools if the daily PR cap is hit.",
          "If blocked, stop the GitHub side and call write_report with what you have.",
        ].join("\n")
      : [
          "Phase 2 (fix / push / PR) is DISABLED for this run.",
          "Do NOT modify source files or call any github write tools.",
          "Post the repro comment, then call write_report.",
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

export function buildReproUserPrompt(issue: CandidateIssue): string {
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
    "Begin now. First, send a visible public note summarizing your understanding of this issue and your initial repro plan. Do not call tools before that note.",
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
  return s.slice(0, max) + `\n… [${s.length - max} chars truncated]`;
}

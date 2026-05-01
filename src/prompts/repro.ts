import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { CandidateIssue } from "../picker.js";

interface BuildReproPromptOptions {
  issue: CandidateIssue;
  /** Absolute path of the working tree (the litellm clone). */
  workdir: string;
  /** Absolute path of the screenshot dir for this run. */
  screenshotDir: string;
  /** Absolute path the agent must write report.md to. */
  reportPath: string;
  /** Stable id used as a screenshot filename prefix and session id. */
  taskId: string;
  /** Whether the agent should also attempt Phase 2 (fix → push → PR → comment) inline. */
  fixEnabled: boolean;
}

const VERDICT_RUBRIC = `
VERDICT RUBRIC (you MUST self-classify on this 0–5 scale):
  5 — Bug fully reproduced, root cause confirmed in code, fix plan validated end-to-end
  4 — Bug reproduced via curl/browser, root cause hypothesis with file:line evidence
  3 — Similar symptoms reproduced but not the exact reported flow
  2 — Partial signal — env starts, related behavior off, but reported flow didn't trigger
  1 — Setup failed (proxy didn't start, deps broken, missing data)
  0 — Unreproducible from the description (insufficient info, env-specific, feature request, question)
`.trim();

const DIFFICULTY_RUBRIC = `
DIFFICULTY RUBRIC (you MUST self-classify):
  easy   — ≤1 file, ≤50 LOC change, no schema/migration changes, no new deps
  medium — ≤3 files, ≤200 LOC total, no DB migrations, no breaking API changes
  hard   — anything else (migrations, breaking changes, large refactors, security-sensitive)
`.trim();

const TOOL_INVENTORY = `
TOOL INVENTORY:

Native (always present):
  shell                 — run any shell command (git, uv, curl, ls, cat, pytest, …) inside the working dir
  curl                  — HTTP requests (localhost only) against the running proxy
  stitch_gif            — assemble a sequence of PNGs into an animated GIF (Phase 2 demo)
  write_report          — MANDATORY FINAL TOOL. Call exactly once with the full structured report.

Browser (Playwright MCP — Microsoft):
  browser_snapshot      — Returns the page's accessibility tree as YAML, with stable refs.
                          ALWAYS take a snapshot BEFORE clicking, so you can target by ref.
  browser_navigate      — Navigate to a URL.
  browser_click         — Click by ref from the latest snapshot. Prefer this over CSS selectors.
  browser_type          — Type into a focused input.
  browser_take_screenshot — Save a viewport screenshot under the run's screenshot dir.
                            Use BEFORE_* prefixes for repro evidence and AFTER_* for fix-verification evidence.
  browser_evaluate      — Run JS in the page context. Use sparingly.
  browser_console_messages, browser_network_requests — page diagnostics
  browser_handle_dialog — accept/dismiss native dialogs

GitHub (GitHub MCP — Anthropic reference server):
  github_get_issue, github_list_issue_comments — read context (you already have the issue body, but
                          there may be later comments worth checking)
  github_search_code    — find code in BerriAI/litellm without grep
  github_fork_repository — no-op if the bot fork already exists
  github_create_branch  — create a branch on the bot fork
  github_push_files, github_create_or_update_file — push your fix to the bot fork
  github_create_pull_request — open a DRAFT PR upstream (BerriAI/litellm:main ← <bot>:<branch>)
  github_add_issue_comment — post the final report-comment on the issue

Note: A git remote called \`shin-bot\` is already configured in the working tree, pointing at your
fork with embedded credentials. You can use \`shell\` with \`git push shin-bot <branch>\` as an
alternative to github_push_files for code changes.
`.trim();

export function buildReproSystemPrompt(opts: BuildReproPromptOptions): string {
  const planRepro = readSkill("plan_repro.md");
  const implementSkill = opts.fixEnabled ? readSkill("implement.md") : null;

  return [
    "You are shin-watcher, an autonomous bug-reproduction (and optionally bug-fix) agent for BerriAI/litellm.",
    "You run unattended on a host machine with the litellm repository cloned and a litellm proxy already running.",
    "",
    "ENVIRONMENT (already prepared for you):",
    `- Working directory (litellm clone): ${opts.workdir}`,
    `- LiteLLM proxy:                     http://localhost:${config.proxy.port} (already running, do NOT start a new one)`,
    `- Master key:                        ${config.proxy.masterKey}`,
    `- Admin login:                       ${config.proxy.uiUsername} / ${config.proxy.uiPassword}`,
    `- Screenshot dir:                    ${opts.screenshotDir}`,
    `- Task id:                           ${opts.taskId}`,
    `- Report path (write_report tool):   ${opts.reportPath}`,
    `- Bot GitHub username:               ${config.github.botUsername}`,
    `- Target repo:                       ${config.github.targetOwner}/${config.github.targetRepo}`,
    `- Bot fork:                          ${config.github.botUsername}/${config.github.targetRepo}`,
    "",
    TOOL_INVENTORY,
    "",
    "MISSION (Phase 1 — REPRODUCE) — always run:",
    "1. Read the issue. If anything is unclear, write your assumed answer in `notes` and proceed —",
    "   you are running unattended, do NOT ask the human.",
    "2. Reproduce the bug using curl + Playwright MCP. ALWAYS call browser_snapshot before clicking",
    "   so your clicks target stable refs, not selectors.",
    "3. Take BEFORE_* screenshots that clearly show the symptom (browser_take_screenshot).",
    "4. Use shell + ripgrep (rg) to locate the bug in the code. Cite file:line and the exact broken line.",
    "5. Self-classify difficulty using the rubric below.",
    "",
    opts.fixEnabled
      ? [
          "MISSION (Phase 2 — FIX) — gated:",
          "Run Phase 2 ONLY IF verdict is ≥ 3 AND difficulty is easy or medium.",
          "If difficulty is hard, write the report with a plan only and stop. Do NOT push code.",
          "",
          "6. Apply the patch in the working tree (use shell — edit files, save).",
          "7. Restart the proxy: `pkill -f 'litellm --config' || true; sleep 2;` then re-start the proxy",
          "   the same way the host did, then poll `/health/readiness`.",
          "8. Re-run the EXACT same repro flow against the patched proxy. Take AFTER_* screenshots.",
          "9. If — and only if — every success criterion is observably met against the patched proxy:",
          "    a. `git checkout -B shin-watcher/issue-<NUMBER>-<SHORT>` (use the task id suffix)",
          "    b. `git add -A && git commit -m '[shin-watcher][auto-repro] Fix: <issue title> (#<n>)'`",
          "    c. `git push shin-bot <branch>` (the remote is already configured)",
          "    d. Use stitch_gif to build screenshots/demo.gif from BEFORE_* + AFTER_*",
          "    e. github_create_pull_request — DRAFT, base=main, head=<bot>:<branch>, title prefixed",
          "       `[shin-watcher][auto-repro]`, body must include BEFORE/AFTER evidence and the GIF",
          "    f. github_add_issue_comment — post the verdict + screenshots + PR link on the issue",
          "    g. Set fix_applied=true and pr_url=<the PR url> in your write_report payload",
          "",
          "If the patched proxy still shows the bug (curl still 500, screenshot still wrong):",
          "    - Set fix_applied=false and explain in `notes`. Do NOT lie about validation.",
          "    - Do NOT push or open a PR.",
          "",
          "If a github_* tool returns a 'cap hit' or 'AUTO_FIX disabled' error:",
          "    - Stop the GitHub side immediately. Finish by calling write_report with what you have.",
        ].join("\n")
      : [
          "Phase 2 (FIX, push, PR, comment) is DISABLED for this run.",
          "Do NOT modify any source files.",
          "Do NOT call any github_* tool that creates, updates, pushes, or comments.",
          "Write the report with a plan only.",
        ].join("\n"),
    "",
    "FINAL STEP (always):",
    "Call `write_report` exactly once with all required fields. The runner ends the run when this tool returns.",
    "Your verdict (0-5) goes at the top of the rendered markdown.",
    "",
    VERDICT_RUBRIC,
    "",
    DIFFICULTY_RUBRIC,
    "",
    "─── SKILL: plan_repro.md ──────────────────────────────────────────────",
    "(IMPORTANT: skip 'Phase 0 — Mini Grill Me'. You have no human to ask. Proceed directly with",
    "Agent 1 (code investigation) and Agent 2 (browser+curl repro) work below, but do it inline yourself —",
    "do NOT spawn subagents.)",
    "",
    planRepro,
    implementSkill
      ? `\n\n─── SKILL: implement.md ──────────────────────────────────\n\n${implementSkill}`
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
            `--- comment by @${c.author} (${c.createdAt}) ---\n${truncate(c.body, 2000)}`
        )
        .join("\n\n")
    : "(no comments)";
  return [
    `Issue #${issue.number}: ${issue.title}`,
    `Reported by @${issue.author} on ${issue.createdAt}`,
    `Labels: ${issue.labels.join(", ") || "(none)"}`,
    `Link: ${issue.htmlUrl}`,
    "",
    "─── ISSUE BODY ──────────────────────────────────────────────",
    truncate(issue.body || "(empty body)", 8000),
    "",
    "─── RECENT COMMENTS (last 5) ────────────────────────────────",
    comments,
    "",
    "Begin Phase 1 now.",
  ].join("\n");
}

function readSkill(filename: string): string {
  const fp = path.join(config.paths.skills, filename);
  if (!fs.existsSync(fp)) {
    throw new Error(`Skill not found: ${fp}. Did you forget to vendor skills/?`);
  }
  return fs.readFileSync(fp, "utf-8");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars] ...`;
}

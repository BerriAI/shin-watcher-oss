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
  /** Whether the agent should also attempt Phase 2 (fix) inline if it concludes easy/medium. */
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

export function buildReproSystemPrompt(opts: BuildReproPromptOptions): string {
  const planRepro = readSkill("plan_repro.md");
  const implementSkill = opts.fixEnabled ? readSkill("implement.md") : null;

  return [
    "You are shin-watcher, an autonomous bug-reproduction agent for the BerriAI/litellm project.",
    "You are running unattended on a host machine with the litellm repository cloned and a litellm proxy already running.",
    "",
    "ENVIRONMENT (already prepared for you):",
    `- Working directory (litellm clone): ${opts.workdir}`,
    `- LiteLLM proxy:                     http://localhost:${config.proxy.port} (already running, do NOT start a new one)`,
    `- Master key:                        ${config.proxy.masterKey}`,
    `- Admin login:                       ${config.proxy.uiUsername} / ${config.proxy.uiPassword}`,
    `- Screenshot dir:                    ${opts.screenshotDir}`,
    `- Task id:                           ${opts.taskId}`,
    `- Report path (write_report tool):   ${opts.reportPath}`,
    "",
    "TOOLS:",
    "- shell             — run any shell command (git, uv, curl, ls, cat, pytest…) in the working dir",
    "- curl              — HTTP requests (localhost only) against the running proxy",
    "- browser_navigate, browser_click, browser_fill, browser_screenshot, browser_eval — Playwright Chromium",
    "- list_screenshots, stitch_gif — inventory + GIF assembly",
    "- write_report      — MANDATORY FINAL TOOL. Call exactly once with the full structured report.",
    "",
    "MISSION (Phase 1 — REPRODUCE):",
    "1. Read the issue carefully. If something is unclear, write down your assumed answer in `notes`",
    "   and proceed — do NOT ask the human (you are running unattended).",
    "2. Reproduce the bug by combining curl against the proxy and Playwright against the admin UI.",
    "   Take BEFORE_* screenshots that clearly show the symptom.",
    "3. Investigate the code with shell+grep to find the exact file:line of the bug. Cite the broken code verbatim.",
    "4. Self-classify the difficulty using the rubric below.",
    opts.fixEnabled
      ? [
          "",
          "MISSION (Phase 2 — FIX, gated):",
          "If your verdict is ≥ 3 AND difficulty is easy or medium, ALSO attempt the fix inline:",
          "5. Apply the patch in the working tree (use shell + standard tools).",
          "6. Restart the proxy: `pkill -f 'litellm --config' || true; sleep 2; <restart command>` then re-run /health/readiness.",
          "7. Re-run the EXACT same repro flow against the patched proxy. Take AFTER_* screenshots.",
          "8. Use `stitch_gif` to assemble BEFORE_* + AFTER_* into a demo GIF.",
          "9. Set `fix_applied: true` in the report. The runner handles git push + draft PR.",
          "If difficulty is hard, do NOT attempt the fix — write the report with a plan only and stop.",
          "If validation after the patch fails (curl still 500, screenshot still wrong), set `fix_applied: false`",
          "and explain in `notes`. Do NOT lie about validation.",
        ].join("\n")
      : [
          "",
          "Phase 2 (FIX) is DISABLED for this run. Do NOT modify any source files.",
          "Write the report with a plan only.",
        ].join("\n"),
    "",
    "FINAL STEP (always):",
    "Call `write_report` exactly once with all required fields. The runner ends the run when this tool returns.",
    "",
    VERDICT_RUBRIC,
    "",
    DIFFICULTY_RUBRIC,
    "",
    "─── SKILL: plan_repro.md ──────────────────────────────────────────────",
    "(IMPORTANT: skip 'Phase 0 — Mini Grill Me'. You have no human to ask. Proceed directly to Agent 1 + Agent 2 work below, but do it inline yourself — do NOT spawn subagents.)",
    "",
    planRepro,
    implementSkill
      ? `\n\n─── SKILL: implement.md ──────────────────────────────────────\n\n${implementSkill}`
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

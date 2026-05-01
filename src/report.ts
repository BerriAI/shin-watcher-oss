import fs from "node:fs";
import path from "node:path";
import type { ReportPayload } from "./tools/writeReport.js";
import type { Difficulty, Verdict } from "./state.js";

export interface RunSummary {
  issueNumber: number;
  verdict: Verdict;
  difficulty: Difficulty;
  fixApplied: boolean;
  prUrl: string | null;
  reportPath: string;
  durationMs: number;
  errorMessage: string | null;
}

/**
 * Write meta.json next to report.md and return the run summary the daemon
 * uses to update state and (optionally) post a comment.
 */
export function summarizeRun(args: {
  issueNumber: number;
  payload: ReportPayload;
  reportPath: string;
  durationMs: number;
  prUrl: string | null;
  errorMessage: string | null;
}): RunSummary {
  const meta = {
    issueNumber: args.issueNumber,
    verdict: args.payload.verdict,
    difficulty: args.payload.difficulty,
    fixApplied: args.payload.fix_applied === true,
    prUrl: args.prUrl,
    reportPath: args.reportPath,
    durationMs: args.durationMs,
    errorMessage: args.errorMessage,
    screenshots: args.payload.screenshots.map((s) => ({
      path: s.path,
      kind: s.kind,
      caption: s.caption,
    })),
    rootCause: args.payload.root_cause,
    successCriteria: args.payload.success_criteria,
  };
  const metaPath = path.join(path.dirname(args.reportPath), "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return {
    issueNumber: args.issueNumber,
    verdict: args.payload.verdict as Verdict,
    difficulty: args.payload.difficulty as Difficulty,
    fixApplied: args.payload.fix_applied === true,
    prUrl: args.prUrl,
    reportPath: args.reportPath,
    durationMs: args.durationMs,
    errorMessage: args.errorMessage,
  };
}

/**
 * Build the markdown comment body that gets posted on the GitHub issue.
 * Image paths in the report are rewritten to gist raw URLs by the github
 * helper before this is called; the agent's `path:` is used as the lookup key.
 */
export function buildIssueComment(args: {
  payload: ReportPayload;
  /** Map: original local path → public URL (Gist raw, S3, …). Empty if posting without uploads. */
  hostedAssets: Map<string, string>;
  prUrl: string | null;
  taskId: string;
  reportArchiveUrl: string | null;
}): string {
  const { payload } = args;
  const status = STATUS_BY_VERDICT[payload.verdict] ?? "UNKNOWN";
  const lines: string[] = [];

  lines.push(`## shin-watcher repro attempt`);
  lines.push("");
  lines.push(
    `**Verdict: ${payload.verdict}/5 — ${status}** · **Difficulty: ${payload.difficulty}** · ` +
      `**Auto-fix:** ${payload.fix_applied ? "applied ✅" : "not attempted"}`
  );
  lines.push("");
  lines.push(`> ${payload.verdict_reasoning}`);
  lines.push("");

  const before = payload.screenshots.filter((s) => s.kind === "before");
  const after = payload.screenshots.filter((s) => s.kind === "after");
  const gifs = payload.screenshots.filter((s) => s.kind === "gif");

  if (before.length) {
    lines.push("### Before (bug confirmed)");
    for (const s of before) {
      const url = args.hostedAssets.get(s.path) ?? s.path;
      lines.push(`![${s.caption}](${url})`);
    }
    lines.push("");
  }

  if (payload.root_cause.length) {
    lines.push("### Root cause");
    for (const rc of payload.root_cause) {
      lines.push(`- \`${rc.file}:${rc.line}\` — ${rc.explanation}`);
    }
    lines.push("");
  }

  if (gifs.length || after.length) {
    lines.push("### After (fix verified)");
    for (const s of gifs) {
      const url = args.hostedAssets.get(s.path) ?? s.path;
      lines.push(`![${s.caption}](${url})`);
    }
    for (const s of after) {
      const url = args.hostedAssets.get(s.path) ?? s.path;
      lines.push(`![${s.caption}](${url})`);
    }
    lines.push("");
  }

  lines.push("### Success criteria");
  for (const c of payload.success_criteria) {
    const box = c.validated ? "[x]" : "[ ]";
    lines.push(`- ${box} ${c.description}`);
  }
  lines.push("");

  if (args.prUrl) {
    lines.push(`### Draft PR`);
    lines.push(args.prUrl);
    lines.push("");
  }

  if (args.reportArchiveUrl) {
    lines.push(`<details><summary>Full report</summary>${args.reportArchiveUrl}</details>`);
    lines.push("");
  }

  lines.push(`<sub>shin-watcher · run \`${args.taskId}\`</sub>`);
  return lines.join("\n");
}

const STATUS_BY_VERDICT: Record<number, string> = {
  0: "UNREPRODUCIBLE",
  1: "SETUP_FAILED",
  2: "PARTIAL",
  3: "SIMILAR_SYMPTOMS",
  4: "REPRODUCED",
  5: "REPRODUCED_AND_VALIDATED",
};

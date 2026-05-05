import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { config } from "../config.js";

const VerdictEnum = Type.Union(
  [
    Type.Literal(0),
    Type.Literal(1),
    Type.Literal(2),
    Type.Literal(3),
    Type.Literal(4),
    Type.Literal(5),
  ],
  {
    description:
      "0=unreproducible, 1=setup failed, 2=partial, 3=similar symptoms, 4=reproduced+root cause, 5=fully validated",
  }
);

const DifficultyEnum = Type.Union(
  [Type.Literal("easy"), Type.Literal("medium"), Type.Literal("hard")],
  {
    description:
      "easy=≤1 file, ≤50 LOC, no migration. medium=≤3 files, ≤200 LOC, no migration/breaking. hard=anything else.",
  }
);

const ScreenshotRef = Type.Object({
  path: Type.String({ description: "Absolute path to the PNG (or GIF)." }),
  caption: Type.String({ description: "Short human-readable caption." }),
  kind: Type.Union(
    [Type.Literal("before"), Type.Literal("after"), Type.Literal("gif")],
    {
      description:
        "'before' = repro evidence, 'after' = fix-verification evidence, 'gif' = stitched demo.",
    }
  ),
});

const RootCauseLocation = Type.Object({
  file: Type.String({
    description: "Repo-relative path, e.g. litellm/proxy/foo.py",
  }),
  line: Type.Number({ description: "1-indexed line number where the bug lives." }),
  quoted_code: Type.String({
    description: "The exact broken line(s), copy-pasted verbatim.",
  }),
  explanation: Type.String({ description: "One-sentence explanation." }),
});

const SuccessCriterion = Type.Object({
  description: Type.String({
    description:
      "What must be true after the fix. E.g. 'POST /team/member_add returns 200'.",
  }),
  validated: Type.Boolean({
    description: "True if the agent confirmed this in Phase 2, false otherwise.",
  }),
  evidence: Type.Optional(
    Type.String({
      description:
        "Optional pointer to evidence (curl command output, test name, screenshot label).",
    })
  ),
});

const WriteReportParams = Type.Object({
  verdict: VerdictEnum,
  difficulty: DifficultyEnum,
  verdict_reasoning: Type.String({
    description:
      "1-3 sentences explaining the verdict score. Reference what was observed and what evidence backs it.",
  }),
  reproduction_steps: Type.Array(Type.String(), {
    description: "Numbered steps a reviewer can follow to reproduce manually.",
  }),
  root_cause: Type.Array(RootCauseLocation, {
    description:
      "File:line citations for each suspected bug location. Empty array if verdict <= 1.",
  }),
  fix_plan: Type.Array(Type.String(), {
    description:
      "Ordered steps describing the proposed fix. Concrete enough that another engineer could implement it.",
  }),
  success_criteria: Type.Array(SuccessCriterion, {
    description:
      "Checklist that defines 'fixed'. Each item must be independently verifiable.",
  }),
  screenshots: Type.Array(ScreenshotRef, {
    description:
      "Every screenshot/GIF the report should embed. Include at least one 'before'. " +
      "For code changes, include matching 'after' proof and a GIF when possible.",
  }),
  fix_applied: Type.Optional(
    Type.Boolean({
      description:
        "True if Phase 2 ran and the patch was applied + validated in this VM.",
    })
  ),
  pr_url: Type.Optional(
    Type.String({
      description:
        "Draft PR URL. Required by default when a concrete code change was identified.",
    })
  ),
  no_action_reason: Type.Optional(
    Type.String({
      description:
        "Only valid no-PR escape hatch. Explain why no actionable code change was possible.",
    })
  ),
  notes: Type.Optional(
    Type.String({
      description:
        "Free-form notes: assumptions made, env quirks, anything a maintainer should know.",
    })
  ),
  task_id: Type.Optional(
    Type.String({
      description:
        "The taskId returned by begin_repro_run. When provided, the report is written to runs/{task_id}/report.md.",
    })
  ),
});

export type ReportPayload = Static<typeof WriteReportParams>;

export interface WriteReportToolOptions {
  /**
   * Default path the agent should write report.md to. Ignored when the
   * payload includes `task_id` (which resolves to runs/{task_id}/report.md).
   */
  reportPath: string;
  /**
   * Called with the parsed payload so the caller can persist + post it.
   * Second arg is the resolved taskId (from payload.task_id or undefined).
   */
  onReport: (payload: ReportPayload, taskId?: string) => void;
}

/**
 * The agent calls this tool exactly once when it's done. It serializes the
 * payload to a markdown report and signals the caller.
 *
 * If payload.task_id is provided (set by begin_repro_run), the report is
 * written to runs/{task_id}/report.md regardless of opts.reportPath.
 *
 * Returning `terminate: true` hints to pi-agent-core that no follow-up LLM call
 * is needed — the run can wind down.
 */
export function makeWriteReportTool(
  opts: WriteReportToolOptions
): AgentTool<typeof WriteReportParams> {
  return {
    name: "write_report",
    label: "Write Report",
    description:
      "MANDATORY FINAL TOOL. Call this exactly once at the end of the run with the structured " +
      "report. Pass the task_id returned by begin_repro_run so the report lands in the correct directory. " +
      "Default policy: include pr_url. Use no_action_reason only when no actionable code change exists.",
    parameters: WriteReportParams,
    execute: async (_id, payload) => {
      if (!payload.pr_url && !payload.no_action_reason) {
        throw new Error(
          "write_report requires pr_url unless no_action_reason is explicitly provided."
        );
      }
      if (payload.pr_url) {
        const beforeCount = payload.screenshots.filter(
          (s) => s.kind === "before"
        ).length;
        const afterCount = payload.screenshots.filter(
          (s) => s.kind === "after"
        ).length;
        if (beforeCount < 1 || afterCount < 1) {
          throw new Error(
            "write_report requires screenshot proof for PRs: at least one BEFORE and one AFTER screenshot when pr_url is provided."
          );
        }
      }
      const resolvedPath = payload.task_id
        ? path.join(config.paths.runs, payload.task_id, "report.md")
        : opts.reportPath;
      const md = renderReportMarkdown(payload);
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, md, "utf-8");
      opts.onReport(payload, payload.task_id ?? undefined);
      return {
        content: [
          {
            type: "text" as const,
            text: `Report written to ${resolvedPath} with verdict ${payload.verdict}/5.`,
          },
        ],
        details: { reportPath: resolvedPath, verdict: payload.verdict },
        terminate: true,
      };
    },
  };
}

const STATUS_BY_VERDICT: Record<number, string> = {
  0: "UNREPRODUCIBLE",
  1: "SETUP_FAILED",
  2: "PARTIAL",
  3: "SIMILAR_SYMPTOMS",
  4: "REPRODUCED",
  5: "REPRODUCED_AND_VALIDATED",
};

export function renderReportMarkdown(p: ReportPayload): string {
  const lines: string[] = [];
  const status = STATUS_BY_VERDICT[p.verdict] ?? "UNKNOWN";
  lines.push(`## Verdict: ${p.verdict}/5 — ${status}`);
  lines.push("");
  lines.push(
    `**Difficulty:** ${p.difficulty}` +
      (p.fix_applied ? " · **Auto-fix:** applied ✅" : "")
  );
  lines.push("");
  lines.push(`**Confidence reasoning:** ${p.verdict_reasoning}`);
  lines.push("");

  // Group screenshots by kind for the BEFORE/AFTER layout.
  const before = p.screenshots.filter((s) => s.kind === "before");
  const after = p.screenshots.filter((s) => s.kind === "after");
  const gifs = p.screenshots.filter((s) => s.kind === "gif");

  if (before.length) {
    lines.push("### Before (bug confirmed)");
    for (const s of before) {
      lines.push(`![${s.caption}](${s.path})`);
      lines.push(`*${s.caption}*`);
      lines.push("");
    }
  }

  if (p.root_cause.length) {
    lines.push("### Root cause");
    for (const rc of p.root_cause) {
      lines.push(`- \`${rc.file}:${rc.line}\` — ${rc.explanation}`);
      lines.push("  ```");
      lines.push(`  ${rc.quoted_code}`);
      lines.push("  ```");
    }
    lines.push("");
  }

  lines.push("### Reproduction steps");
  p.reproduction_steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("");

  lines.push("### Fix plan");
  p.fix_plan.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("");

  if (after.length || gifs.length) {
    lines.push("### After (fix verified)");
    for (const s of gifs) {
      lines.push(`![${s.caption}](${s.path})`);
      lines.push(`*${s.caption}*`);
      lines.push("");
    }
    for (const s of after) {
      lines.push(`![${s.caption}](${s.path})`);
      lines.push(`*${s.caption}*`);
      lines.push("");
    }
  }

  lines.push("### Success criteria");
  for (const c of p.success_criteria) {
    const box = c.validated ? "[x]" : "[ ]";
    const evidence = c.evidence ? ` _(${c.evidence})_` : "";
    lines.push(`- ${box} ${c.description}${evidence}`);
  }
  lines.push("");

  if (p.pr_url) {
    lines.push(`### Draft PR`);
    lines.push(p.pr_url);
    lines.push("");
  }

  if (p.no_action_reason) {
    lines.push("### No action taken");
    lines.push(p.no_action_reason);
    lines.push("");
  }

  if (p.notes) {
    lines.push("### Notes");
    lines.push(p.notes);
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by shin-watcher.*");
  return lines.join("\n");
}

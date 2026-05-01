import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const execAsync = promisify(exec);

const ShellParams = Type.Object({
  command: Type.String({
    description:
      "Shell command to execute. Runs with /bin/bash -c inside the agent's working directory.",
  }),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Per-command timeout in seconds. Default 120, max 600.",
      minimum: 1,
      maximum: 600,
    })
  ),
  workdir: Type.Optional(
    Type.String({
      description:
        "Optional subdirectory (relative to the agent's pinned root) to run in.",
    })
  ),
});

export interface ShellToolOptions {
  /** Absolute path that all commands are sandboxed inside. */
  rootDir: string;
  /** Cap on stdout+stderr returned to the model. Excess is truncated. */
  maxOutputBytes?: number;
}

const MAX_OUTPUT_DEFAULT = 64_000;

export function makeShellTool(opts: ShellToolOptions): AgentTool<typeof ShellParams> {
  return {
    name: "shell",
    label: "Shell",
    description:
      "Run a shell command in the cloned BerriAI/litellm working tree. Use this for git, uv, curl, ls, cat, pytest, etc. " +
      "Output is truncated to the last ~64KB. The proxy is already running on :4000 — do NOT start another one.",
    parameters: ShellParams,
    execute: async (
      _toolCallId: string,
      params: Static<typeof ShellParams>,
      signal?: AbortSignal
    ) => {
      const cwd = resolveCwd(opts.rootDir, params.workdir);
      const timeoutMs = (params.timeout_seconds ?? 120) * 1000;
      const maxBytes = opts.maxOutputBytes ?? MAX_OUTPUT_DEFAULT;

      try {
        const { stdout, stderr } = await execAsync(params.command, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: maxBytes * 4,
          signal,
          shell: "/bin/bash",
          env: process.env,
        });
        const out = truncate(stdout, maxBytes);
        const err = truncate(stderr, maxBytes);
        const text = formatShellOutput({ exitCode: 0, stdout: out, stderr: err, cwd });
        return {
          content: [{ type: "text" as const, text }],
          details: { exitCode: 0, cwd, command: params.command },
        };
      } catch (e) {
        const err = e as NodeJS.ErrnoException & {
          code?: number | string;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
          signal?: string;
        };
        const exitCode =
          typeof err.code === "number" ? err.code : err.killed ? 124 : 1;
        const text = formatShellOutput({
          exitCode,
          stdout: truncate(err.stdout ?? "", maxBytes),
          stderr: truncate(err.stderr ?? err.message ?? "", maxBytes),
          cwd,
          killed: err.killed,
          signal: err.signal,
        });
        // Non-zero exits are returned as content (not thrown) so the model can
        // observe and react. Real exceptions (signal, timeout) still flow as text.
        return {
          content: [{ type: "text" as const, text }],
          details: { exitCode, cwd, command: params.command, killed: err.killed },
        };
      }
    },
  };
}

function resolveCwd(rootDir: string, sub?: string): string {
  if (!sub || sub === "." || sub === "./") return rootDir;
  // Block escape attempts. Path.resolve flattens ../ but we want a hard error.
  if (sub.startsWith("/") || sub.includes("..")) {
    throw new Error(`workdir must be relative and within the root: ${sub}`);
  }
  return `${rootDir}/${sub}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max / 4));
  const tail = s.slice(-Math.floor((max * 3) / 4));
  return `${head}\n... [truncated ${s.length - max} bytes] ...\n${tail}`;
}

function formatShellOutput(args: {
  exitCode: number;
  stdout: string;
  stderr: string;
  cwd: string;
  killed?: boolean;
  signal?: string;
}): string {
  const parts: string[] = [];
  parts.push(`$ (cwd=${args.cwd}) exit=${args.exitCode}`);
  if (args.killed) parts.push(`# killed (signal=${args.signal ?? "?"})`);
  if (args.stdout) parts.push(`--- stdout ---\n${args.stdout}`);
  if (args.stderr) parts.push(`--- stderr ---\n${args.stderr}`);
  if (!args.stdout && !args.stderr) parts.push("(no output)");
  return parts.join("\n");
}

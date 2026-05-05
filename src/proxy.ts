import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { interpolate, type Profile } from "./profile.js";

export interface ProxyCredentials {
  masterKey: string;
  uiUsername: string;
  uiPassword: string;
}

/**
 * Generate ephemeral admin credentials for a per-run sandbox proxy.
 * These don't need to be stable — each repro run boots its own isolated
 * service on a unique port, so creds are scoped to that single run.
 */
export function generateProxyCredentials(): ProxyCredentials {
  return {
    masterKey: `sk-${crypto.randomBytes(24).toString("hex")}`,
    uiUsername: "admin",
    uiPassword: crypto.randomBytes(24).toString("hex"),
  };
}

/**
 * Default starting port for per-run sandbox services. Bumped from 4000 to
 * avoid collision with the LiteLLM proxy that handles shin-watcher's own
 * LLM calls (LITELLM_BASE_URL).
 */
export const SANDBOX_PROXY_PORT_START = 5001;

export interface ProxyHandle {
  pid: number;
  port: number;
  logPath: string;
  workdir: string;
  stop(): Promise<void>;
}

export interface PrepareOptions {
  /** Local path where the target repo should be cloned/refreshed. */
  workdir: string;
  /** Profile describing the target repo (clone URL, optional install command). */
  profile: Profile;
  /** Override the profile's default ref. */
  ref?: string;
}

/**
 * Make sure the workdir exists and is at a clean origin/<ref>, then run
 * the profile's optional install command. The first call performs a
 * shallow clone; subsequent calls fetch + reset --hard + clean -fdx
 * (much faster than re-cloning a 100k-commit repo).
 */
export async function prepareWorkdir(opts: PrepareOptions): Promise<string> {
  const { profile } = opts;
  const ref = opts.ref ?? profile.defaultRef;
  const target = path.resolve(opts.workdir);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (!fs.existsSync(path.join(target, ".git"))) {
    await runCommand("git", ["clone", "--depth", "50", profile.cloneUrl, target]);
  }

  // Fetch latest commits. The explicit refspec writes the remote-tracking ref
  // even on a shallow clone where "fetch origin main" only writes FETCH_HEAD.
  await runCommand(
    "git",
    ["fetch", "origin", `+refs/heads/${ref}:refs/remotes/origin/${ref}`, "--depth", "50"],
    target
  );
  await runCommand("git", ["reset", "--hard", `origin/${ref}`], target);
  await runCommand("git", ["clean", "-fdx"], target);

  if (profile.install) {
    const [command, ...args] = splitCommand(profile.install.command);
    await runCommand(command, args, target);
  }

  return target;
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed` +
            (signal ? ` with signal ${signal}` : ` with exit code ${code}`)
        )
      );
    });
  });
}

export interface StartProxyOptions {
  workdir: string;
  port: number;
  /** Profile providing the start command, env, and health check. */
  profile: Profile;
  masterKey: string;
  uiUsername: string;
  uiPassword: string;
  databaseUrl?: string;
  /** Path to write proxy stdout+stderr. */
  logPath: string;
  /** How long to wait for readiness per attempt in ms. Default: profile's healthCheck.timeoutMs. */
  readinessTimeoutMs?: number;
  /** Max attempts before giving up (default 3). */
  maxAttempts?: number;
  /** Called before each retry so callers can emit progress events. */
  onRetry?: (attempt: number, maxAttempts: number, shortError: string) => void;
}

/**
 * Launch the target service inside the prepared workdir using the start
 * command and env vars from the profile. Resolves once the profile's
 * health check URL responds with 2xx. Retries up to maxAttempts (default 3)
 * on timeout, calling onRetry between attempts.
 */
export async function startProxy(opts: StartProxyOptions): Promise<ProxyHandle> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastError = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1 && opts.onRetry) {
      opts.onRetry(attempt, maxAttempts, lastError);
    }

    try {
      return await startProxyOnce(opts);
    } catch (e) {
      lastError = firstMeaningfulLine((e as Error).message);
      if (attempt === maxAttempts) break;
      console.warn(`[proxy] attempt ${attempt}/${maxAttempts} failed: ${lastError} — retrying`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  throw new Error(
    `${opts.profile.name} service failed after ${maxAttempts} attempts. Last error: ${lastError}`
  );
}

async function startProxyOnce(opts: StartProxyOptions): Promise<ProxyHandle> {
  fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
  const out = fs.openSync(opts.logPath, "w");

  const placeholders: Record<string, string | number> = {
    port: opts.port,
    master_key: opts.masterKey,
    ui_username: opts.uiUsername,
    ui_password: opts.uiPassword,
  };

  const interpolatedCommand = interpolate(opts.profile.start.command, placeholders);
  const [command, ...args] = splitCommand(interpolatedCommand);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...interpolateEnv(opts.profile.start.env, placeholders),
  };
  if (opts.databaseUrl) env.DATABASE_URL = opts.databaseUrl;

  const child: ChildProcess = spawn(command, args, {
    cwd: opts.workdir,
    env,
    stdio: ["ignore", out, out],
    detached: true,
  });

  if (!child.pid) {
    fs.closeSync(out);
    throw new Error(`Failed to spawn ${opts.profile.name} service`);
  }
  const pid = child.pid;
  child.unref();

  const healthUrl = interpolate(opts.profile.healthCheck.url, placeholders);
  const timeoutMs = opts.readinessTimeoutMs ?? opts.profile.healthCheck.timeoutMs;

  const ready = await waitForReadiness(healthUrl, timeoutMs);
  if (!ready) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    fs.closeSync(out);
    const tail = readTail(opts.logPath, 60);
    throw new Error(
      `${opts.profile.name} service did not become ready on :${opts.port} within ${timeoutMs}ms.\n` +
        `--- last 60 log lines ---\n${tail}`
    );
  }

  return {
    pid,
    port: opts.port,
    logPath: opts.logPath,
    workdir: opts.workdir,
    async stop() {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        fs.closeSync(out);
      } catch {
        /* already closed */
      }
    },
  };
}

function interpolateEnv(
  env: Record<string, string>,
  placeholders: Record<string, string | number>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = interpolate(value, placeholders);
  }
  return result;
}

/**
 * Split a shell-like command string into [command, ...args] by whitespace.
 * Profile commands are author-controlled, so we don't need to handle
 * embedded quotes or spaces inside arguments. If a future profile needs
 * that, swap this for `shell-quote` or similar.
 */
function splitCommand(command: string): [string, ...string[]] {
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") {
    throw new Error("Empty command string");
  }
  return parts as [string, ...string[]];
}

function firstMeaningfulLine(msg: string): string {
  const line = msg.split("\n").find((l) => l.trim() && !l.startsWith("---"));
  return (line ?? msg).slice(0, 200);
}

async function waitForReadiness(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

function readTail(filePath: string, lines: number): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log available)";
  }
}

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ProxyHandle {
  pid: number;
  port: number;
  logPath: string;
  workdir: string;
  stop(): Promise<void>;
}

export interface PrepareOptions {
  /** Local path where litellm should be cloned/refreshed. */
  workdir: string;
  /** GitHub URL to clone from (defaults to https://github.com/BerriAI/litellm). */
  cloneUrl?: string;
  /** Branch/ref to reset to (default "main"). */
  ref?: string;
}

/**
 * Make sure ./workdir/litellm exists and is at a clean origin/<ref>.
 * Creates a fresh shallow clone the first time, then `fetch + reset --hard + clean -fdx`
 * on subsequent runs (much faster than re-cloning a 100k-commit repo).
 */
export async function prepareWorkdir(opts: PrepareOptions): Promise<string> {
  const cloneUrl = opts.cloneUrl ?? "https://github.com/BerriAI/litellm.git";
  const ref = opts.ref ?? "main";
  const target = path.resolve(opts.workdir);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (!fs.existsSync(path.join(target, ".git"))) {
    await runCommand("git", ["clone", "--depth", "50", cloneUrl, target]);
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

  return target;
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });
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
  masterKey: string;
  uiUsername: string;
  uiPassword: string;
  databaseUrl?: string;
  /** Path to write proxy stdout+stderr. */
  logPath: string;
  /** How long to wait for /health/readiness per attempt in ms (default 90s). */
  readinessTimeoutMs?: number;
  /** Max attempts before giving up (default 3). */
  maxAttempts?: number;
  /** Called before each retry so callers can emit progress events. */
  onRetry?: (attempt: number, maxAttempts: number, shortError: string) => void;
}

/**
 * Start `uv run --extra proxy litellm --config proxy_server_config.yaml --port <port>` from inside
 * the prepared workdir. Resolves once /health/readiness returns 200.
 * Retries up to maxAttempts (default 3) on timeout, calling onRetry between attempts.
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

  throw new Error(`LiteLLM proxy failed after ${maxAttempts} attempts. Last error: ${lastError}`);
}

async function startProxyOnce(opts: StartProxyOptions): Promise<ProxyHandle> {
  fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
  const out = fs.openSync(opts.logPath, "w");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LITELLM_MASTER_KEY: opts.masterKey,
    UI_USERNAME: opts.uiUsername,
    UI_PASSWORD: opts.uiPassword,
  };
  if (opts.databaseUrl) env.DATABASE_URL = opts.databaseUrl;

  const child: ChildProcess = spawn(
    "uv",
    [
      "run",
      "--extra",
      "proxy",
      "litellm",
      "--config",
      "proxy_server_config.yaml",
      "--port",
      String(opts.port),
    ],
    {
      cwd: opts.workdir,
      env,
      stdio: ["ignore", out, out],
      detached: true,
    }
  );

  if (!child.pid) {
    fs.closeSync(out);
    throw new Error("Failed to spawn litellm proxy");
  }
  const pid = child.pid;
  child.unref();

  const ready = await waitForReadiness(
    `http://localhost:${opts.port}/health/readiness`,
    opts.readinessTimeoutMs ?? 90_000
  );
  if (!ready) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    fs.closeSync(out);
    const tail = readTail(opts.logPath, 60);
    throw new Error(
      `litellm proxy did not become ready on :${opts.port} within ${
        opts.readinessTimeoutMs ?? 90_000
      }ms.\n--- last 60 log lines ---\n${tail}`
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

/** Return just the first non-empty, non-separator line from an error message. */
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

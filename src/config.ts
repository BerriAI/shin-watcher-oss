import dotenv from "dotenv";

// Prefer `.env` over pre-set shell vars so local edits take effect (e.g. IDE/terminal exports).
dotenv.config({ override: true });
import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Env var ${name} must be an integer, got: ${value}`);
  }
  return n;
}

const repoRoot = process.cwd();

export const config = {
  litellm: {
    baseUrl: required("LITELLM_BASE_URL"),
    apiKey: required("LITELLM_API_KEY"),
    modelId: required("LITELLM_MODEL_ID"),
  },
  dashboard: {
    masterKey: required("DASHBOARD_MASTER_KEY"),
    username: required("DASHBOARD_USERNAME"),
    password: required("DASHBOARD_PASSWORD"),
    sessionSecret: required("DASHBOARD_SESSION_SECRET"),
    cookieSecure: bool("DASHBOARD_COOKIE_SECURE", process.env["NODE_ENV"] === "production"),
  },
  github: {
    token: required("GITHUB_TOKEN"),
    botUsername: required("GITHUB_BOT_USERNAME"),
    targetOwner: optional("TARGET_REPO_OWNER", "BerriAI"),
    targetRepo: optional("TARGET_REPO_NAME", "litellm"),
  },
  slack: {
    useBolt: bool("SLACK_USE_BOLT", true),
    signingSecret: optional("SLACK_SIGNING_SECRET", ""),
    botToken: optional("SLACK_BOT_TOKEN", ""),
    botUserId: optional("SLACK_BOT_USER_ID", ""),
    appToken: optional("SLACK_APP_TOKEN", ""),
    pollEnabled: bool("SLACK_POLL_ENABLED", false),
    pollChannels: optional("SLACK_POLL_CHANNELS", ""),
    pollIntervalSec: int("SLACK_POLL_INTERVAL_SEC", 10),
  },
  schedule: {
    intervalMin: int("INTERVAL_MIN", 15),
    maxRunMinutes: int("MAX_RUN_MINUTES", 20),
    batchIntervalMin: int("BATCH_INTERVAL_MIN", 0),   // 0 = disabled
    batchSize: int("BATCH_SIZE", 10),
  },
  flags: {
    postComments: bool("POST_COMMENTS", false),
    autoFix: bool("AUTO_FIX", false),
    maxFixPrsPerDay: int("MAX_FIX_PRS_PER_DAY", 5),
  },
  paths: {
    workdir: path.resolve(repoRoot, optional("WORKDIR", "./workdir")),
    runs: path.resolve(repoRoot, optional("RUNS_DIR", "./runs")),
    stateDb: path.resolve(repoRoot, optional("STATE_DB", "./state.sqlite")),
    skills: path.resolve(repoRoot, "skills"),
    screenshots: optional("SCREENSHOT_DIR", "/tmp/shin-watcher-screenshots"),
  },
} as const;

export type Config = typeof config;

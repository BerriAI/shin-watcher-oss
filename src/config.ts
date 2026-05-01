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
  github: {
    token: required("GITHUB_TOKEN"),
    botUsername: required("GITHUB_BOT_USERNAME"),
    targetOwner: optional("TARGET_REPO_OWNER", "BerriAI"),
    targetRepo: optional("TARGET_REPO_NAME", "litellm"),
  },
  schedule: {
    intervalMin: int("INTERVAL_MIN", 15),
    maxRunMinutes: int("MAX_RUN_MINUTES", 20),
  },
  flags: {
    postComments: bool("POST_COMMENTS", false),
    autoFix: bool("AUTO_FIX", false),
    maxFixPrsPerDay: int("MAX_FIX_PRS_PER_DAY", 5),
  },
  proxy: {
    masterKey: optional("PROXY_MASTER_KEY", "sk-1234"),
    uiUsername: optional("PROXY_UI_USERNAME", "admin"),
    uiPassword: optional("PROXY_UI_PASSWORD", "admin123"),
    sandboxDbUrl: optional("LITELLM_SANDBOX_DB_URL", ""),
    port: int("PROXY_PORT", 4000),
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

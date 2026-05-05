import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

/**
 * A profile bundles everything specific to one target repository:
 * how to clone it, how to launch its service, how to know the service
 * is ready, plus the reproduction skill and prompt addendum the agent
 * uses when working on it.
 *
 * Profiles live under `profiles/<name>/` and are selected at startup
 * via the `PROFILE` env var (defaults to "litellm").
 */
export interface Profile {
  /** Profile identifier. Must match the folder name under `profiles/`. */
  name: string;

  /** Git URL to clone the target repository from. */
  cloneUrl: string;

  /** Branch, tag, or commit to check out after clone (e.g. "main"). */
  defaultRef: string;

  /** Optional install step run once after clone, before start. */
  install?: {
    command: string;
  };

  /**
   * How to launch the target service.
   *
   * `command` and the values inside `env` may contain placeholders
   * that are interpolated per repro run:
   *   {port}          allocated proxy port
   *   {master_key}    generated master key
   *   {ui_username}   generated UI username
   *   {ui_password}   generated UI password
   */
  start: {
    command: string;
    env: Record<string, string>;
  };

  /** How to know the service is ready. `url` may contain {port}. */
  healthCheck: {
    url: string;
    timeoutMs: number;
  };

  /** Optional UI URL the agent can navigate to. May contain {port}. */
  uiUrl?: string;

  /** Full markdown text of the reproduction skill (loaded from repro.md). */
  repro: string;

  /** System prompt addendum (loaded from prompt.md). */
  prompt: string;
}

const PROFILES_ROOT = path.resolve(process.cwd(), "profiles");

/**
 * Load a profile by name from `profiles/<name>/`.
 *
 * Reads `config.yaml`, `repro.md`, and `prompt.md` from the profile folder
 * and assembles them into a single `Profile`. Throws with a clear message
 * if the folder or any required file is missing or malformed.
 */
export function loadProfile(name: string): Profile {
  const profileDir = path.join(PROFILES_ROOT, name);
  assertDirExists(profileDir, name);

  const configPath = path.join(profileDir, "config.yaml");
  const reproPath = path.join(profileDir, "repro.md");
  const promptPath = path.join(profileDir, "prompt.md");

  assertFileExists(configPath, name, "config.yaml");
  assertFileExists(reproPath, name, "repro.md");
  assertFileExists(promptPath, name, "prompt.md");

  const rawConfig = parseProfileConfig(configPath, name);
  if (rawConfig.name !== name) {
    throw new Error(
      `Profile '${name}': config.yaml has name='${rawConfig.name}', which does not match the folder name.`
    );
  }

  return {
    name: rawConfig.name,
    cloneUrl: rawConfig.clone_url,
    defaultRef: rawConfig.default_ref ?? "main",
    install: rawConfig.install,
    start: {
      command: rawConfig.start.command,
      env: rawConfig.start.env,
    },
    healthCheck: {
      url: rawConfig.health_check.url,
      timeoutMs: rawConfig.health_check.timeout_ms,
    },
    uiUrl: rawConfig.ui_url,
    repro: fs.readFileSync(reproPath, "utf-8"),
    prompt: fs.readFileSync(promptPath, "utf-8"),
  };
}

/** List the names of all profiles available under `profiles/`. */
export function listProfiles(): string[] {
  if (!fs.existsSync(PROFILES_ROOT)) return [];
  return fs
    .readdirSync(PROFILES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Substitute placeholders like {port}, {master_key} in a string with the
 * given values. Used by the proxy launcher to expand the start command,
 * env vars, and health check URL.
 */
export function interpolate(
  template: string,
  values: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value !== undefined ? String(value) : match;
  });
}

interface RawProfileConfig {
  name: string;
  clone_url: string;
  default_ref?: string;
  install?: { command: string };
  start: { command: string; env: Record<string, string> };
  health_check: { url: string; timeout_ms: number };
  ui_url?: string;
}

function parseProfileConfig(filePath: string, name: string): RawProfileConfig {
  const raw = fs.readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (e) {
    throw new Error(
      `Profile '${name}': failed to parse config.yaml: ${(e as Error).message}`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Profile '${name}': config.yaml must contain a YAML object.`);
  }

  const config = parsed as Partial<RawProfileConfig>;
  const required: (keyof RawProfileConfig)[] = [
    "name",
    "clone_url",
    "start",
    "health_check",
  ];
  for (const field of required) {
    if (!config[field]) {
      throw new Error(`Profile '${name}': config.yaml is missing required field '${field}'.`);
    }
  }
  return config as RawProfileConfig;
}

function assertDirExists(dir: string, name: string): void {
  if (!fs.existsSync(dir)) {
    const available = listProfiles();
    const hint = available.length
      ? `Available profiles: ${available.join(", ")}.`
      : "No profiles found under profiles/.";
    throw new Error(`Profile '${name}' not found at ${dir}. ${hint}`);
  }
}

function assertFileExists(filePath: string, name: string, fileName: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Profile '${name}' is missing ${fileName} at ${filePath}.`);
  }
}

import { execFileSync } from "node:child_process";
import { config } from "./config.js";

/**
 * One-time setup: make sure the bot account has a fork of the target repo.
 *
 * Called from the runner BEFORE the agent runs, so by the time the agent uses
 * `github_fork_repository` (a no-op when the fork exists) or pushes a branch,
 * the fork is already there.
 *
 * Uses the `gh` CLI (must be authenticated as the bot). Idempotent: checks
 * existence first via `gh repo view`, then forks only if missing.
 */
export function ensureFork(): string {
  const fork = `${config.github.botUsername}/${config.github.targetRepo}`;
  try {
    execFileSync("gh", ["repo", "view", fork], { stdio: "pipe" });
  } catch {
    execFileSync(
      "gh",
      [
        "repo",
        "fork",
        `${config.github.targetOwner}/${config.github.targetRepo}`,
        "--clone=false",
        "--remote=false",
      ],
      { stdio: "inherit" }
    );
  }
  return `https://github.com/${fork}.git`;
}

/**
 * Add the bot's fork as a git remote in the working tree, so the agent can
 * `git push shin-bot <branch>` later. Idempotent. Returns the remote name.
 */
export function ensureBotRemote(workdir: string): string {
  const fork = ensureFork();
  // Embed the bot's PAT in the URL so the agent's git push works without
  // any credential prompts. The remote URL is local-only and won't leak.
  const authUrl = fork.replace(
    "https://",
    `https://${config.github.botUsername}:${config.github.token}@`
  );
  try {
    execFileSync("git", ["remote", "remove", "shin-bot"], {
      cwd: workdir,
      stdio: "pipe",
    });
  } catch {
    /* no such remote yet */
  }
  execFileSync("git", ["remote", "add", "shin-bot", authUrl], {
    cwd: workdir,
    stdio: "inherit",
  });
  return "shin-bot";
}

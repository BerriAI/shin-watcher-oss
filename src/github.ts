import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

export class GitHubClient {
  private octokit: Octokit;

  constructor() {
    this.octokit = new Octokit({ auth: config.github.token });
  }

  /**
   * Post a comment on the target issue. No-op if POST_COMMENTS is false.
   * Returns the comment URL when posted, null otherwise.
   */
  async postIssueComment(issueNumber: number, body: string): Promise<string | null> {
    if (!config.flags.postComments) return null;
    const { data } = await this.octokit.issues.createComment({
      owner: config.github.targetOwner,
      repo: config.github.targetRepo,
      issue_number: issueNumber,
      body,
    });
    return data.html_url;
  }

  /**
   * Upload a list of files (PNG/GIF) to a private gist and return a map of
   * local-path → gist raw URL. We use one gist per run so we get a single
   * cleanup target later.
   */
  async uploadAssetsToGist(
    files: string[],
    description: string
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!files.length) return out;
    if (!config.flags.postComments) return out; // gist is only useful when commenting

    const gistFiles: Record<string, { content: string }> = {};
    // GitHub Gists are text-only. Encode binary as base64 with a clear filename.
    for (const fp of files) {
      const buf = fs.readFileSync(fp);
      const name = path.basename(fp) + ".b64";
      gistFiles[name] = { content: buf.toString("base64") };
    }
    const { data } = await this.octokit.gists.create({
      description,
      public: false,
      files: gistFiles,
    });
    for (const fp of files) {
      const name = path.basename(fp) + ".b64";
      const file = data.files?.[name];
      if (file?.raw_url) out.set(fp, file.raw_url);
    }
    return out;
  }

  /**
   * Ensure the bot has a fork of the target repo. Uses `gh` CLI (must be
   * authenticated as the bot). Returns the fork's https URL.
   */
  ensureFork(): string {
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
   * From inside `workdir` (a clone of BerriAI/litellm with local edits),
   * push the current branch to the bot's fork and open a draft PR upstream.
   * Returns the PR URL.
   */
  async pushBranchAndOpenDraftPr(args: {
    workdir: string;
    branch: string;
    issueNumber: number;
    issueTitle: string;
    body: string;
  }): Promise<string> {
    const forkUrl = this.ensureFork();

    // Add or update the bot remote.
    try {
      execFileSync("git", ["remote", "remove", "shin-bot"], {
        cwd: args.workdir,
        stdio: "pipe",
      });
    } catch {
      /* no such remote, ignore */
    }
    execFileSync("git", ["remote", "add", "shin-bot", forkUrl], {
      cwd: args.workdir,
      stdio: "inherit",
    });

    // Make sure we're on the named branch with everything committed.
    execFileSync("git", ["checkout", "-B", args.branch], {
      cwd: args.workdir,
      stdio: "inherit",
    });
    // Stage and commit any unstaged changes.
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: args.workdir,
      encoding: "utf-8",
    });
    if (status.trim()) {
      execFileSync("git", ["add", "-A"], { cwd: args.workdir, stdio: "inherit" });
      execFileSync(
        "git",
        [
          "commit",
          "-m",
          `[shin-watcher][auto-repro] Fix: ${args.issueTitle} (#${args.issueNumber})`,
        ],
        { cwd: args.workdir, stdio: "inherit" }
      );
    }

    // Push to the bot fork (force to overwrite any earlier auto-attempt on the same branch).
    execFileSync("git", ["push", "-f", "shin-bot", `${args.branch}:${args.branch}`], {
      cwd: args.workdir,
      stdio: "inherit",
    });

    const { data } = await this.octokit.pulls.create({
      owner: config.github.targetOwner,
      repo: config.github.targetRepo,
      title: `[shin-watcher][auto-repro] ${args.issueTitle} (#${args.issueNumber})`,
      head: `${config.github.botUsername}:${args.branch}`,
      base: "main",
      body: args.body,
      draft: true,
      maintainer_can_modify: true,
    });
    return data.html_url;
  }
}

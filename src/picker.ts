import { Octokit } from "@octokit/rest";
import type { State } from "./state.js";

export interface CandidateIssue {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  author: string;
  labels: string[];
  createdAt: string;
  recentComments: Array<{ author: string; body: string; createdAt: string }>;
}

const SKIP_TITLE_TOKENS = [
  "[feature]",
  "[feat]",
  "feature request",
  "[question]",
  "[discussion]",
  "[rfc]",
  "[docs]",
];

function looksLikeNonBug(title: string, labels: string[]): boolean {
  const t = title.toLowerCase();
  if (SKIP_TITLE_TOKENS.some((tok) => t.includes(tok))) return true;
  const skipLabels = new Set([
    "documentation",
    "question",
    "discussion",
    "feature",
    "enhancement",
    "good first issue",
    "duplicate",
    "wontfix",
    "invalid",
  ]);
  return labels.some((l) => skipLabels.has(l.toLowerCase()));
}

export class Picker {
  private octokit: Octokit;
  constructor(
    token: string,
    private owner: string,
    private repo: string,
    private state: State
  ) {
    this.octokit = new Octokit({ auth: token });
  }

  /**
   * Returns the next issue to work on, or null if nothing is eligible.
   * Strategy: scan up to 100 most recently updated open issues, skip PRs,
   * skip clearly-non-bug titles/labels, skip anything in cooldown.
   * Pick the most recently updated remaining one.
   */
  async pickNext(): Promise<CandidateIssue | null> {
    const { data } = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });

    for (const issue of data) {
      // listForRepo includes PRs — filter them out.
      if (issue.pull_request) continue;
      const labels = issue.labels.map((l) =>
        typeof l === "string" ? l : l.name ?? ""
      );
      if (looksLikeNonBug(issue.title, labels)) continue;
      if (this.state.isInCooldown(issue.number)) continue;

      const recentComments = await this.fetchRecentComments(issue.number);
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        htmlUrl: issue.html_url,
        author: issue.user?.login ?? "unknown",
        labels,
        createdAt: issue.created_at,
        recentComments,
      };
    }
    return null;
  }

  async fetchOne(issueNumber: number): Promise<CandidateIssue> {
    const { data: issue } = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    if (issue.pull_request) {
      throw new Error(`#${issueNumber} is a pull request, not an issue`);
    }
    const labels = issue.labels.map((l) =>
      typeof l === "string" ? l : l.name ?? ""
    );
    const recentComments = await this.fetchRecentComments(issueNumber);
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      htmlUrl: issue.html_url,
      author: issue.user?.login ?? "unknown",
      labels,
      createdAt: issue.created_at,
      recentComments,
    };
  }

  private async fetchRecentComments(
    issueNumber: number
  ): Promise<CandidateIssue["recentComments"]> {
    const { data } = await this.octokit.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    // Take the last 5 comments — they usually contain the most useful repro context.
    return data.slice(-5).map((c) => ({
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at,
    }));
  }
}

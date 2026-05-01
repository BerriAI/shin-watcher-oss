import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Verdict = 0 | 1 | 2 | 3 | 4 | 5;
export type Difficulty = "easy" | "medium" | "hard";

export interface Attempt {
  issueNumber: number;
  attemptedAt: string; // ISO timestamp
  verdict: Verdict;
  difficulty: Difficulty | null;
  reportPath: string;
  prUrl: string | null;
  durationMs: number;
  errorMessage: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number INTEGER NOT NULL,
  attempted_at TEXT NOT NULL,
  verdict INTEGER NOT NULL,
  difficulty TEXT,
  report_path TEXT NOT NULL,
  pr_url TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_issue ON attempts(issue_number);
CREATE INDEX IF NOT EXISTS idx_attempts_at ON attempts(attempted_at);

CREATE TABLE IF NOT EXISTS open_prs (
  pr_url TEXT PRIMARY KEY,
  issue_number INTEGER NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_open_prs_issue ON open_prs(issue_number);
`;

export class State {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  recordAttempt(a: Omit<Attempt, "attemptedAt"> & { attemptedAt?: string }): void {
    const stmt = this.db.prepare(`
      INSERT INTO attempts
        (issue_number, attempted_at, verdict, difficulty, report_path, pr_url, duration_ms, error_message)
      VALUES
        (@issueNumber, @attemptedAt, @verdict, @difficulty, @reportPath, @prUrl, @durationMs, @errorMessage)
    `);
    stmt.run({
      issueNumber: a.issueNumber,
      attemptedAt: a.attemptedAt ?? new Date().toISOString(),
      verdict: a.verdict,
      difficulty: a.difficulty,
      reportPath: a.reportPath,
      prUrl: a.prUrl,
      durationMs: a.durationMs,
      errorMessage: a.errorMessage,
    });
  }

  lastAttemptForIssue(issueNumber: number): Attempt | null {
    const row = this.db
      .prepare(
        `SELECT issue_number AS issueNumber,
                attempted_at AS attemptedAt,
                verdict,
                difficulty,
                report_path AS reportPath,
                pr_url AS prUrl,
                duration_ms AS durationMs,
                error_message AS errorMessage
         FROM attempts
         WHERE issue_number = ?
         ORDER BY attempted_at DESC
         LIMIT 1`
      )
      .get(issueNumber) as Attempt | undefined;
    return row ?? null;
  }

  /**
   * Cooldown rules:
   *   - verdict >= 4 → don't re-attempt for 7 days
   *   - verdict <= 1 → don't re-attempt for 30 days
   *   - open auto-PR for this issue → never re-attempt while it's open
   *   - 2 ≤ verdict ≤ 3 → 24-hour cooldown to avoid burning loops
   */
  isInCooldown(issueNumber: number, now = new Date()): boolean {
    if (this.hasOpenPr(issueNumber)) return true;
    const last = this.lastAttemptForIssue(issueNumber);
    if (!last) return false;
    const ageMs = now.getTime() - new Date(last.attemptedAt).getTime();
    const day = 24 * 60 * 60 * 1000;
    if (last.verdict >= 4) return ageMs < 7 * day;
    if (last.verdict <= 1) return ageMs < 30 * day;
    return ageMs < 1 * day;
  }

  attemptedIssueNumbers(): Set<number> {
    const rows = this.db
      .prepare(`SELECT DISTINCT issue_number AS n FROM attempts`)
      .all() as Array<{ n: number }>;
    return new Set(rows.map((r) => r.n));
  }

  recordOpenPr(prUrl: string, issueNumber: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO open_prs (pr_url, issue_number, opened_at, closed_at)
         VALUES (?, ?, ?, NULL)`
      )
      .run(prUrl, issueNumber, new Date().toISOString());
  }

  markPrClosed(prUrl: string): void {
    this.db
      .prepare(`UPDATE open_prs SET closed_at = ? WHERE pr_url = ?`)
      .run(new Date().toISOString(), prUrl);
  }

  hasOpenPr(issueNumber: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM open_prs WHERE issue_number = ? AND closed_at IS NULL LIMIT 1`
      )
      .get(issueNumber);
    return row !== undefined;
  }

  countFixPrsToday(now = new Date()): number {
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    ).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM open_prs WHERE opened_at >= ?`
      )
      .get(startOfDay) as { n: number };
    return row.n;
  }
}

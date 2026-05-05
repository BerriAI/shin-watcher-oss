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

export type SlackTaskStatus =
  | "pending" // row inserted, runRootChat not yet started
  | "running" // runRootChat is actively processing
  | "done" // onDone fired, Slack closed
  | "failed" // onError fired, Slack got error message
  | "abandoned"; // process died mid-task; recovered on next boot

export interface SlackTask {
  id: number;
  channel: string;
  threadTs: string;
  messageTs: string;
  kind: "direct" | "channel";
  rawText: string;
  enrichedMessage: string;
  sessionId: string;
  langfuseSessionId: string;
  placeholderTs: string | null;
  status: SlackTaskStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  lastNudgeAt: string | null;
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

-- Durable record of every incoming Slack message, used to guarantee
-- closure (every message ends with a real Slack reply or a 'we crashed,
-- please resend' notice). Pending/running rows are scanned on boot for
-- recovery; a global poller scans long-running rows for stalls.
CREATE TABLE IF NOT EXISTS slack_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  enriched_message TEXT NOT NULL,
  session_id TEXT NOT NULL,
  langfuse_session_id TEXT NOT NULL,
  placeholder_ts TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  error_message TEXT,
  last_nudge_at TEXT,
  UNIQUE(channel, message_ts)
);
CREATE INDEX IF NOT EXISTS idx_slack_tasks_status ON slack_tasks(status);
CREATE INDEX IF NOT EXISTS idx_slack_tasks_updated ON slack_tasks(updated_at);
`;

const SLACK_TASK_COLUMNS = `
  id,
  channel,
  thread_ts AS threadTs,
  message_ts AS messageTs,
  kind,
  raw_text AS rawText,
  enriched_message AS enrichedMessage,
  session_id AS sessionId,
  langfuse_session_id AS langfuseSessionId,
  placeholder_ts AS placeholderTs,
  status,
  attempts,
  created_at AS createdAt,
  updated_at AS updatedAt,
  finished_at AS finishedAt,
  error_message AS errorMessage,
  last_nudge_at AS lastNudgeAt
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

  // ── Slack task durability ─────────────────────────────────────────────
  // Used by src/slack/bolt.ts to guarantee that every incoming Slack
  // message either ends with a real reply or is recovered with a "we
  // crashed, please resend" notice on the next boot.

  /**
   * Idempotent insert. Returns { id, isNew } where isNew=false means this
   * Slack message (channel + messageTs) was already recorded previously.
   * Callers should no-op when isNew=false to avoid duplicate processing.
   */
  recordSlackTask(t: {
    channel: string;
    threadTs: string;
    messageTs: string;
    kind: "direct" | "channel";
    rawText: string;
    enrichedMessage: string;
    sessionId: string;
    langfuseSessionId: string;
  }): { id: number; isNew: boolean } {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT id FROM slack_tasks WHERE channel = ? AND message_ts = ?`)
      .get(t.channel, t.messageTs) as { id: number } | undefined;
    if (existing) return { id: existing.id, isNew: false };
    const result = this.db
      .prepare(
        `INSERT INTO slack_tasks
          (channel, thread_ts, message_ts, kind, raw_text, enriched_message,
           session_id, langfuse_session_id, status, created_at, updated_at)
         VALUES
          (@channel, @threadTs, @messageTs, @kind, @rawText, @enrichedMessage,
           @sessionId, @langfuseSessionId, 'pending', @now, @now)`
      )
      .run({ ...t, now });
    return { id: result.lastInsertRowid as number, isNew: true };
  }

  markSlackTaskRunning(id: number, placeholderTs: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE slack_tasks
         SET status = 'running',
             placeholder_ts = COALESCE(?, placeholder_ts),
             attempts = attempts + 1,
             updated_at = ?
         WHERE id = ?`
      )
      .run(placeholderTs, now, id);
  }

  markSlackTaskDone(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE slack_tasks
         SET status = 'done', finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, id);
  }

  markSlackTaskFailed(id: number, errorMessage: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE slack_tasks
         SET status = 'failed', error_message = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(errorMessage.slice(0, 2000), now, now, id);
  }

  markSlackTaskAbandoned(id: number, errorMessage: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE slack_tasks
         SET status = 'abandoned', error_message = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(errorMessage.slice(0, 2000), now, now, id);
  }

  /** Bumps updated_at so the global poller can distinguish active vs. stuck rows. */
  bumpSlackTaskActivity(id: number): void {
    this.db
      .prepare(`UPDATE slack_tasks SET updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  markSlackTaskNudged(id: number): void {
    this.db
      .prepare(`UPDATE slack_tasks SET last_nudge_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  /** Rows that were in flight when the process died. Used at boot for recovery. */
  findOrphanedSlackTasks(): SlackTask[] {
    return this.db
      .prepare(
        `SELECT ${SLACK_TASK_COLUMNS}
         FROM slack_tasks
         WHERE status IN ('pending', 'running')
         ORDER BY id ASC`
      )
      .all() as SlackTask[];
  }

  /**
   * Rows currently 'running' whose updated_at is older than `maxIdleMs`.
   * Used by the global poller to detect actually-stuck tasks (vs. tasks
   * making steady progress, which bump updated_at on every agent event).
   */
  findStuckSlackTasks(maxIdleMs: number, now = new Date()): SlackTask[] {
    const cutoff = new Date(now.getTime() - maxIdleMs).toISOString();
    return this.db
      .prepare(
        `SELECT ${SLACK_TASK_COLUMNS}
         FROM slack_tasks
         WHERE status = 'running' AND updated_at < ?
         ORDER BY updated_at ASC`
      )
      .all(cutoff) as SlackTask[];
  }

  /**
   * Recent Slack tasks for dashboard display. `statusFilter` is an optional
   * subset of statuses to include — passing nothing returns all.
   */
  recentSlackTasks(opts?: {
    statuses?: SlackTaskStatus[];
    limit?: number;
  }): SlackTask[] {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500);
    const statuses = opts?.statuses;
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => "?").join(",");
      return this.db
        .prepare(
          `SELECT ${SLACK_TASK_COLUMNS}
           FROM slack_tasks
           WHERE status IN (${placeholders})
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(...statuses, limit) as SlackTask[];
    }
    return this.db
      .prepare(
        `SELECT ${SLACK_TASK_COLUMNS}
         FROM slack_tasks
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit) as SlackTask[];
  }

  getSlackTask(id: number): SlackTask | null {
    const row = this.db
      .prepare(
        `SELECT ${SLACK_TASK_COLUMNS} FROM slack_tasks WHERE id = ?`
      )
      .get(id) as SlackTask | undefined;
    return row ?? null;
  }

  countSlackTasksByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM slack_tasks GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}

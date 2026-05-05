import crypto from "node:crypto";

/**
 * Compute the on-disk directory name for a session's run artifacts (transcript,
 * screenshots). Used by both the writer (dashboard/session.ts) and the reader
 * (dashboard/server.ts) so they always agree.
 *
 * Historically this used `sessionId.slice(0, 12)`, which collides for every
 * Slack-channel session (they all start with "slack:channel:") and every
 * Slack DM session ("slack:direct:"). The collision caused the task detail
 * page to show events from concurrent threads mixed together — the dashboard
 * was reading one shared transcript file for every channel thread we'd ever
 * run.
 *
 * Now we keep a short human-readable prefix for grep-ability and append a
 * stable hash of the FULL session id so different threads never collide.
 */
export function sessionDirName(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
  const hash = crypto
    .createHash("sha1")
    .update(sessionId)
    .digest("hex")
    .slice(0, 12);
  return `session-${safe}-${hash}`;
}

/**
 * Legacy directory name (pre-fix). The reader falls back to this so task
 * pages for tasks recorded before the fix still render — at the cost of the
 * known cross-task interleaving on those old shared files.
 */
export function legacySessionDirName(sessionId: string): string {
  return `session-${sessionId.slice(0, 12)}`;
}

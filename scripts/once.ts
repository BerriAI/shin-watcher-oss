#!/usr/bin/env tsx
/**
 * Run shin-watcher exactly once against either:
 *   - a specific issue:   tsx scripts/once.ts --issue 9876
 *   - the next eligible:  tsx scripts/once.ts
 *
 * Use this for first-runs and debugging — bypasses cron, runs in foreground,
 * exits with code 0 on success and 1 on failure.
 */
import { Runner } from "../src/runner.js";

function parseIssueArg(): number | undefined {
  const idx = process.argv.indexOf("--issue");
  if (idx === -1) return undefined;
  const raw = process.argv[idx + 1];
  if (!raw) {
    console.error("Usage: tsx scripts/once.ts [--issue <number>]");
    process.exit(2);
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    console.error(`--issue must be an integer, got: ${raw}`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const issueNumber = parseIssueArg();
  const runner = new Runner();
  try {
    const summary = await runner.runOne(issueNumber);
    if (!summary) {
      console.log("[once] no eligible issue (everything in cooldown?)");
      process.exit(0);
    }
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.errorMessage ? 1 : 0);
  } finally {
    runner.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

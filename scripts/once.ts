#!/usr/bin/env tsx
/**
 * Start the shin-watcher chat UI at http://localhost:3333.
 * Optionally run one issue immediately:
 *   tsx scripts/once.ts            → open chat, idle until you invoke via UI
 *   tsx scripts/once.ts --issue 9876 → auto-start that issue then stay alive
 *   tsx scripts/once.ts --next       → auto-start next eligible then stay alive
 *
 * The server stays alive after the run so you can invoke more runs from the chat.
 * Ctrl-C to quit.
 */
import { Runner } from "../src/runner.js";
import { startDashboard } from "../src/dashboard/server.js";

function parseArgs(): { issueNumber?: number; runNext?: boolean } {
  const args = process.argv.slice(2);
  if (args.includes("--next")) return { runNext: true };
  const idx = args.indexOf("--issue");
  if (idx !== -1) {
    const n = parseInt(args[idx + 1] ?? "", 10);
    if (!isNaN(n)) return { issueNumber: n };
  }
  return {};
}

async function main(): Promise<void> {
  const { issueNumber, runNext } = parseArgs();
  const runner = new Runner();
  startDashboard(runner, 3333);

  // If invoked with --issue or --next, kick off immediately; then stay alive.
  if (issueNumber !== undefined || runNext) {
    const summary = await runner.runOne(issueNumber).catch((e) => {
      console.error("[once] run error:", e);
      return null;
    });
    if (summary) console.log("[once] done:", JSON.stringify(summary));
  }

  // Keep the server alive indefinitely so the chat UI stays reachable.
  console.log("  Waiting for commands via http://localhost:3333  (Ctrl-C to quit)\n");
  process.stdin.resume();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

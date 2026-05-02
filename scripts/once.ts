#!/usr/bin/env tsx
/**
 * Start the shin-watcher chat UI at http://localhost:3333.
 * Optionally kick off a repro immediately by passing text to the root agent:
 *   tsx scripts/once.ts                       → open chat, idle until you invoke via UI
 *   tsx scripts/once.ts --issue 9876          → agent gets "Reproduce issue #9876"
 *   tsx scripts/once.ts --next                → agent gets "Pick and reproduce the next eligible bug"
 *
 * The server stays alive after the run so you can invoke more via the chat.
 * Ctrl-C to quit.
 */
import { startDashboard } from "../src/dashboard/server.js";
import { SessionManager, awaitSessionAgent } from "../src/dashboard/session.js";

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
  startDashboard(3333);

  if (issueNumber !== undefined || runNext) {
    const msg = issueNumber
      ? `Reproduce issue #${issueNumber} on BerriAI/litellm.`
      : "Pick the next eligible open bug on BerriAI/litellm and reproduce it.";

    const session = SessionManager.getOrCreate("cli-once");
    const agent = await awaitSessionAgent(session, 90_000).catch((e) => {
      console.error("[once] agent init error:", e);
      return null;
    });

    if (agent) {
      (agent as unknown as { prompt: (m: string) => Promise<void> })
        .prompt(msg)
        .catch((e) => console.error("[once] prompt error:", e));
    }
  }

  console.log("  Waiting for commands via http://localhost:3333  (Ctrl-C to quit)\n");
  process.stdin.resume();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

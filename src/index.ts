/**
 * shin-watcher daemon.
 *
 * Every INTERVAL_MIN, picks the next eligible issue on the configured target
 * repository and runs one repro+(optional)fix cycle. Sequential: only one
 * issue is processed at a time, even if the cron tick fires while a previous
 * run is still going.
 */
import cron from "node-cron";
import { config } from "./config.js";
import { Runner } from "./runner.js";

let running = false;

async function tick(runner: Runner): Promise<void> {
  if (running) {
    console.log("[daemon] previous run still in progress; skipping this tick");
    return;
  }
  running = true;
  try {
    await runner.runOne();
  } catch (e) {
    console.error("[daemon] runOne threw:", e);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  const runner = new Runner();
  const cronExpr = `*/${config.schedule.intervalMin} * * * *`;
  console.log(
    `[daemon] starting shin-watcher
  cadence:        ${cronExpr} (every ${config.schedule.intervalMin} min)
  profile:        ${config.profile}
  target:         ${config.github.targetOwner}/${config.github.targetRepo}
  llm proxy:      ${config.litellm.baseUrl}
  model:          ${config.litellm.modelId}
  AUTO_FIX:       ${config.flags.autoFix}
  POST_COMMENTS:  ${config.flags.postComments}
  max run:        ${config.schedule.maxRunMinutes} min
  daily PR cap:   ${config.flags.maxFixPrsPerDay}`
  );

  // Run once immediately on boot so we don't wait INTERVAL_MIN for the first cycle.
  await tick(runner);

  cron.schedule(cronExpr, () => {
    void tick(runner);
  });

  // Hold the event loop forever.
  const shutdown = async (sig: string) => {
    console.log(`[daemon] received ${sig}; shutting down`);
    runner.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[daemon] fatal:", e);
  process.exit(1);
});

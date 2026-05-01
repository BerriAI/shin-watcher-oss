#!/usr/bin/env tsx
/**
 * Smoke test: spawn Playwright MCP + GitHub MCP via the bridge and list their
 * tool names + first-line descriptions. Confirms the bridge wiring works.
 *
 * Usage: GITHUB_TOKEN=ghp_... tsx scripts/smoke-mcp.ts
 */
import path from "node:path";
import os from "node:os";
import "dotenv/config";
import { McpBridge } from "../src/mcp/bridge.js";

async function main(): Promise<void> {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    console.error("GITHUB_TOKEN not set; skipping GitHub MCP smoke test");
  }

  const bridge = new McpBridge();
  const outputDir = path.join(os.tmpdir(), "shin-watcher-smoke");
  try {
    console.log("→ spawning Playwright MCP …");
    const browserTools = await bridge.connect({
      name: "browser",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        "--headless",
        "--isolated",
        `--output-dir=${outputDir}`,
      ],
      prefix: "",
    });
    console.log(`  ✔ ${browserTools.length} tools`);
    for (const t of browserTools) {
      console.log(`    - ${t.name}: ${(t.description ?? "").split("\n")[0]?.slice(0, 80)}`);
    }

    if (ghToken) {
      console.log("\n→ spawning GitHub MCP …");
      const ghTools = await bridge.connect({
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: ghToken },
      });
      console.log(`  ✔ ${ghTools.length} tools`);
      for (const t of ghTools) {
        console.log(`    - ${t.name}: ${(t.description ?? "").split("\n")[0]?.slice(0, 80)}`);
      }
    }
  } finally {
    await bridge.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

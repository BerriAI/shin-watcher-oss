import { config } from "../config.js";
import type { McpServerConfig } from "./bridge.js";

/**
 * MCP server config: GitHub.
 *
 * Uses Anthropic's reference GitHub MCP server. Tools include:
 *   create_or_update_file, push_files, fork_repository, create_branch,
 *   create_pull_request, create_issue, add_issue_comment, list_issues,
 *   search_code, search_repositories, get_pull_request, get_issue, ...
 *
 * The agent uses these to: post the final comment on the issue, and (in
 * Phase 2) push to the bot fork + open a draft PR upstream.
 *
 * The `beforeToolCall` hook in agent.ts blocks any of these write operations
 * when the daily PR cap is hit, so the agent can't bypass our limits.
 */
export function githubMcpServer(): McpServerConfig {
  return {
    name: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {
      // The MCP server reads this. We pass the bot's PAT.
      GITHUB_PERSONAL_ACCESS_TOKEN: config.github.token,
    },
    // Drop the truly destructive tools we will never want.
    blockedTools: [
      "delete_file", // we never delete files via this agent
    ],
  };
}

/**
 * MCP server config: Playwright.
 *
 * Microsoft's official Playwright MCP. Provides snapshot/ref-based browser
 * automation, which is significantly more reliable than CSS-selector clicks
 * for an LLM. Tools include:
 *   browser_navigate, browser_snapshot, browser_click, browser_type,
 *   browser_take_screenshot, browser_console_messages, browser_network_requests,
 *   browser_evaluate, browser_handle_dialog, browser_resize, browser_close, ...
 *
 * Pass --headless so it runs unattended, and --viewport-size for a sane
 * default that matches the litellm admin UI's design width.
 *
 * Pass --output-dir so screenshots land in OUR run directory rather than
 * Playwright MCP's tmpdir, so we can find and embed them later.
 */
export function playwrightMcpServer(args: { outputDir: string }): McpServerConfig {
  return {
    name: "browser",
    command: "npx",
    args: [
      "-y",
      "@playwright/mcp@latest",
      "--headless",
      "--isolated",
      "--viewport-size=1280,800",
      `--output-dir=${args.outputDir}`,
    ],
    // Empty prefix — keep tool names exactly as Microsoft documents them
    // (browser_snapshot, browser_click, …) so the agent can use docs verbatim.
    prefix: "",
  };
}

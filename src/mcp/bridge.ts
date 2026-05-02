/**
 * Bridge: MCP server → pi-agent-core AgentTool[].
 *
 * pi-agent-core does not support MCP natively (the maintainer's design choice —
 * see https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/).
 * This file is the smallest possible adapter that lets us reuse the broader
 * MCP ecosystem (Microsoft's Playwright MCP, GitHub's MCP server, etc.) anyway.
 *
 * Lifecycle:
 *   const bridge = new McpBridge();
 *   const tools = await bridge.connect({ name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN } });
 *   // ...use tools in pi-agent-core Agent...
 *   await bridge.dispose();
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export interface McpServerConfig {
  /** Logical name. Used as a prefix on every tool name, e.g. "github_create_pull_request". */
  name: string;
  /** Executable to spawn (typically "npx"). */
  command: string;
  /** Args (typically `["-y", "@some/mcp-package@latest"]`). */
  args: string[];
  /** Env vars passed to the subprocess (e.g. GITHUB_TOKEN). Inherits process.env on top. */
  env?: Record<string, string>;
  /** If set, only expose tools whose unprefixed name is in this list. */
  allowedTools?: string[];
  /** If set, drop tools whose unprefixed name is in this list (applied after allowedTools). */
  blockedTools?: string[];
  /** Override the prefix (defaults to `name + "_"`). Pass "" to disable prefixing. */
  prefix?: string;
}

interface MountedServer {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport;
}

const MCP_CONNECT_TIMEOUT_MS = 30_000;
const MCP_MAX_ATTEMPTS = 3;

export class McpBridge {
  private servers: MountedServer[] = [];

  /**
   * Spawn an MCP server with retry+timeout. Returns empty tool list if all
   * attempts fail (degraded mode) so the agent can still run without that MCP.
   */
  async connect(config: McpServerConfig): Promise<AgentTool[]> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MCP_MAX_ATTEMPTS; attempt++) {
      try {
        return await this._connectOnce(config);
      } catch (e) {
        lastErr = e;
        const delay = attempt * 2_000;
        console.warn(
          `[mcp:${config.name}] connect attempt ${attempt}/${MCP_MAX_ATTEMPTS} failed (${String(e)}); retrying in ${delay}ms`
        );
        if (attempt < MCP_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    console.error(
      `[mcp:${config.name}] all ${MCP_MAX_ATTEMPTS} connect attempts failed — running without these tools. Last error:`,
      lastErr
    );
    return []; // degraded: agent continues without this server's tools
  }

  private async _connectOnce(config: McpServerConfig): Promise<AgentTool[]> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...sanitizeEnv(process.env), ...(config.env ?? {}) },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "shin-watcher", version: "0.1.0" },
      { capabilities: {} }
    );

    // Race the connect against a timeout so a hung npx download doesn't block forever.
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`MCP connect timeout after ${MCP_CONNECT_TIMEOUT_MS}ms`)),
          MCP_CONNECT_TIMEOUT_MS
        )
      ),
    ]);

    // Surface server stderr to our process stderr — invaluable when an MCP
    // server crashes on startup.
    transport.stderr?.on("data", (chunk) => {
      process.stderr.write(`[mcp:${config.name}] ${chunk}`);
    });

    const { tools } = await client.listTools();
    this.servers.push({ config, client, transport });

    const prefix = config.prefix ?? `${config.name}_`;
    return tools
      .filter((t) => {
        if (config.allowedTools && !config.allowedTools.includes(t.name)) return false;
        if (config.blockedTools && config.blockedTools.includes(t.name)) return false;
        return true;
      })
      .map((t) => wrapMcpTool(client, t, prefix));
  }

  async dispose(): Promise<void> {
    for (const s of this.servers) {
      try {
        await s.client.close();
      } catch {
        /* swallow */
      }
    }
    this.servers = [];
  }
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, object>; required?: string[] };
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

function wrapMcpTool(
  client: Client,
  mcpTool: McpToolDescriptor,
  prefix: string
): AgentTool {
  // Type.Unsafe lets us treat any JSON Schema as a typebox TSchema. The MCP
  // server already validates inputs server-side, so client-side validation is
  // redundant — we just pass the schema through to the LLM and forward args.
  const parameters = Type.Unsafe<unknown>(mcpTool.inputSchema);

  return {
    name: `${prefix}${mcpTool.name}`,
    label: mcpTool.name,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const result = (await client.callTool(
        {
          name: mcpTool.name,
          arguments: (params ?? {}) as Record<string, unknown>,
        },
        undefined,
        { signal }
      )) as { content?: McpContentBlock[]; isError?: boolean; structuredContent?: unknown };

      const content = (result.content ?? []).flatMap((c): Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > => {
        if (c.type === "text" && typeof c.text === "string") {
          return [{ type: "text", text: c.text }];
        }
        if (c.type === "image" && c.data && c.mimeType) {
          return [{ type: "image", data: c.data, mimeType: c.mimeType }];
        }
        // Fallback for resource/embedded/unknown types: stringify so the model
        // still sees something rather than nothing.
        return [{ type: "text", text: JSON.stringify(c) }];
      });

      if (result.isError) {
        // MCP servers signal errors via isError + textual content. Throw so
        // pi-agent-core records this as a tool error to the LLM.
        const msg = content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        throw new Error(msg || `MCP tool ${mcpTool.name} returned isError`);
      }

      return {
        content: content.length ? content : [{ type: "text", text: "(no content)" }],
        details: { tool: mcpTool.name, structured: result.structuredContent },
      };
    },
  } as AgentTool;
}

/**
 * Strip undefined values so the StdioClientTransport env type is satisfied.
 * Node's process.env technically maps strings to string | undefined.
 */
function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

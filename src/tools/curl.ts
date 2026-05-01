import { Type, type Static } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const CurlParams = Type.Object({
  method: Type.Union(
    [
      Type.Literal("GET"),
      Type.Literal("POST"),
      Type.Literal("PUT"),
      Type.Literal("PATCH"),
      Type.Literal("DELETE"),
      Type.Literal("HEAD"),
    ],
    { description: "HTTP method." }
  ),
  url: Type.String({
    description:
      "Absolute URL. Only http://localhost:* and https://localhost:* are allowed for safety.",
  }),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Headers to send (e.g. Authorization, Content-Type).",
    })
  ),
  body: Type.Optional(
    Type.String({
      description:
        "Request body as a string. For JSON, set Content-Type and pass JSON-encoded text here.",
    })
  ),
  follow_redirects: Type.Optional(Type.Boolean()),
});

export interface CurlToolOptions {
  /** Cap on response body bytes returned to the model. */
  maxResponseBytes?: number;
}

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
const MAX_BYTES_DEFAULT = 64_000;

export function makeCurlTool(opts: CurlToolOptions = {}): AgentTool<typeof CurlParams> {
  return {
    name: "curl",
    label: "HTTP",
    description:
      "Make an HTTP request to the local litellm proxy (localhost only). " +
      "Use this for /login, /team/new, /user/new, /team/member_add, /project/new, etc. " +
      "Response body is truncated to ~64KB. Returns status, headers, and body as text.",
    parameters: CurlParams,
    execute: async (
      _toolCallId: string,
      params: Static<typeof CurlParams>,
      signal?: AbortSignal
    ) => {
      const url = new URL(params.url);
      if (!ALLOWED_HOSTS.has(url.hostname)) {
        throw new Error(
          `curl tool only allows localhost requests. Got hostname: ${url.hostname}`
        );
      }
      const maxBytes = opts.maxResponseBytes ?? MAX_BYTES_DEFAULT;

      const res = await fetch(url, {
        method: params.method,
        headers: params.headers,
        body:
          params.body && params.method !== "GET" && params.method !== "HEAD"
            ? params.body
            : undefined,
        redirect: params.follow_redirects === false ? "manual" : "follow",
        signal,
      });

      const contentType = res.headers.get("content-type") ?? "";
      let bodyText: string;
      if (contentType.startsWith("image/") || contentType.includes("octet-stream")) {
        const buf = Buffer.from(await res.arrayBuffer());
        bodyText = `<binary ${contentType}, ${buf.byteLength} bytes>`;
      } else {
        bodyText = await res.text();
        if (bodyText.length > maxBytes) {
          bodyText =
            bodyText.slice(0, maxBytes) +
            `\n... [truncated ${bodyText.length - maxBytes} bytes] ...`;
        }
      }

      const headersOut: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headersOut[k] = v;
      });

      const text = [
        `${params.method} ${params.url} → ${res.status} ${res.statusText}`,
        `--- headers ---`,
        Object.entries(headersOut)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
        `--- body ---`,
        bodyText,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          status: res.status,
          ok: res.ok,
          url: params.url,
          headers: headersOut,
        },
      };
    },
  };
}

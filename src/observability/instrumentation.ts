/**
 * Langfuse / OpenTelemetry bootstrap.
 *
 * Import this file FIRST at the entrypoint (before any other imports that
 * might do LLM work). It:
 *   1. Loads dotenv (so LANGFUSE_* env vars are populated).
 *   2. Starts a NodeSDK with the LangfuseSpanProcessor.
 *   3. Registers shutdown hooks so traces flush before the process exits.
 *
 * If LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are missing, we no-op
 * (warn once) so dev environments without Langfuse keep working.
 */

import dotenv from "dotenv";

// Load .env BEFORE constructing the Langfuse processor — the SDK reads
// credentials at construction time. This must happen before any other
// import in the entrypoint reaches Langfuse-using code.
dotenv.config({ override: true });

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
const baseUrl =
  process.env.LANGFUSE_BASE_URL?.trim() ||
  process.env.LANGFUSE_HOST?.trim() ||
  "https://cloud.langfuse.com";

let sdk: NodeSDK | null = null;

if (publicKey && secretKey) {
  sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({ baseUrl, publicKey, secretKey }),
    ],
  });
  sdk.start();

  console.log(`[langfuse] tracing enabled → ${baseUrl}`);

  const shutdown = async (): Promise<void> => {
    try {
      await sdk?.shutdown();
    } catch (err) {
      console.error("[langfuse] shutdown error:", err);
    }
  };

  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("beforeExit", () => {
    void shutdown();
  });
} else {
  console.warn(
    "[langfuse] tracing disabled — set LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY to enable."
  );
}

export { sdk as langfuseSdk };

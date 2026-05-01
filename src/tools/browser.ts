import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type { AgentTool } from "@mariozechner/pi-agent-core";

/**
 * BrowserSession owns ONE Chromium instance + one page for the lifetime of an
 * agent run. It is lazily started on first tool call and torn down explicitly
 * by the runner via close().
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(
    private screenshotDir: string,
    private taskId: string
  ) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  async ensure(): Promise<Page> {
    if (this.page) return this.page;
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    this.page = await this.context.newPage();
    return this.page;
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async screenshot(label: string): Promise<string> {
    const page = await this.ensure();
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    const filename = `${this.taskId}_${Date.now()}_${safe}.png`;
    const filepath = path.join(this.screenshotDir, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    return filepath;
  }
}

/* ─────────────────────── tool factories ─────────────────────── */

const NavParams = Type.Object({
  url: Type.String({ description: "URL to navigate to (http://localhost:4000/...)." }),
  wait_for_selector: Type.Optional(
    Type.String({
      description: "Optional CSS selector to wait for after navigation.",
    })
  ),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1000, maximum: 120_000 })),
});

const ClickParams = Type.Object({
  selector: Type.String({
    description: "Playwright selector (CSS, text=, role=). Must uniquely match.",
  }),
  timeout_ms: Type.Optional(Type.Number({ minimum: 100, maximum: 30_000 })),
});

const FillParams = Type.Object({
  selector: Type.String({ description: "Playwright selector for an input/textarea." }),
  value: Type.String({ description: "Text to fill (replaces existing value)." }),
});

const ScreenshotParams = Type.Object({
  label: Type.String({
    description:
      "Short label for the file (a–z, 0–9, _, -). Becomes part of the filename. " +
      "Use BEFORE_* for repro screenshots and AFTER_* for fix-verification screenshots.",
  }),
});

const EvalParams = Type.Object({
  expression: Type.String({
    description:
      "JavaScript expression to evaluate in the page context. Returned value is JSON-stringified.",
  }),
});

export function makeBrowserTools(session: BrowserSession): AgentTool[] {
  return [
    {
      name: "browser_navigate",
      label: "Navigate",
      description:
        "Navigate the headless Chromium browser to a URL. Optionally wait for a selector. " +
        "Reuses the same page across calls. Returns the page title and final URL.",
      parameters: NavParams,
      execute: async (_id, p: Static<typeof NavParams>) => {
        const page = await session.ensure();
        await page.goto(p.url, {
          waitUntil: "domcontentloaded",
          timeout: p.timeout_ms ?? 30_000,
        });
        if (p.wait_for_selector) {
          await page.waitForSelector(p.wait_for_selector, {
            timeout: p.timeout_ms ?? 30_000,
          });
        }
        const title = await page.title();
        const finalUrl = page.url();
        return {
          content: [
            {
              type: "text" as const,
              text: `Navigated to ${finalUrl}\nTitle: ${title}`,
            },
          ],
          details: { url: finalUrl, title },
        };
      },
    } as AgentTool<typeof NavParams>,

    {
      name: "browser_click",
      label: "Click",
      description: "Click an element matched by a Playwright selector.",
      parameters: ClickParams,
      execute: async (_id, p: Static<typeof ClickParams>) => {
        const page = await session.ensure();
        await page.click(p.selector, { timeout: p.timeout_ms ?? 5_000 });
        return {
          content: [{ type: "text" as const, text: `Clicked: ${p.selector}` }],
          details: { selector: p.selector },
        };
      },
    } as AgentTool<typeof ClickParams>,

    {
      name: "browser_fill",
      label: "Fill",
      description: "Fill a text input/textarea with the given value (replaces existing).",
      parameters: FillParams,
      execute: async (_id, p: Static<typeof FillParams>) => {
        const page = await session.ensure();
        await page.fill(p.selector, p.value);
        return {
          content: [{ type: "text" as const, text: `Filled ${p.selector}` }],
          details: { selector: p.selector },
        };
      },
    } as AgentTool<typeof FillParams>,

    {
      name: "browser_screenshot",
      label: "Screenshot",
      description:
        "Take a viewport screenshot. Use label prefix BEFORE_* for repro evidence and " +
        "AFTER_* for fix-verification evidence. Filename auto-includes task id and timestamp.",
      parameters: ScreenshotParams,
      execute: async (_id, p: Static<typeof ScreenshotParams>) => {
        const filepath = await session.screenshot(p.label);
        return {
          content: [
            { type: "text" as const, text: `Screenshot saved: ${filepath}` },
          ],
          details: { path: filepath, label: p.label },
        };
      },
    } as AgentTool<typeof ScreenshotParams>,

    {
      name: "browser_eval",
      label: "Eval JS",
      description:
        "Evaluate a JavaScript expression in the current page context. " +
        "Use sparingly — prefer click/fill/navigate. Returns JSON-stringified value.",
      parameters: EvalParams,
      execute: async (_id, p: Static<typeof EvalParams>) => {
        const page = await session.ensure();
        const value = await page.evaluate(p.expression);
        const text = JSON.stringify(value, null, 2) ?? "undefined";
        return {
          content: [{ type: "text" as const, text }],
          details: { value },
        };
      },
    } as AgentTool<typeof EvalParams>,
  ];
}

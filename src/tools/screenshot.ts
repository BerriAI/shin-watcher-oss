import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const execFileAsync = promisify(execFile);

const StitchGifParams = Type.Object({
  inputs: Type.Array(
    Type.String({
      description:
        "Absolute path to a PNG screenshot. List in playback order (e.g. BEFORE → step → AFTER).",
    }),
    { minItems: 2, maxItems: 30 }
  ),
  output_path: Type.String({
    description:
      "Absolute path for the output .gif. Should live under the run's screenshots/ dir.",
  }),
  delay_ms_per_frame: Type.Optional(
    Type.Number({
      description: "Delay between frames in ms. Default 1500.",
      minimum: 100,
      maximum: 10_000,
    })
  ),
  width: Type.Optional(
    Type.Number({
      description:
        "Resize all frames to this width (preserves aspect ratio). Keeps the GIF small. Default 960.",
      minimum: 200,
      maximum: 1920,
    })
  ),
});

/**
 * Stitch a sequence of PNGs into an animated GIF using ImageMagick.
 *
 * Why this exists: Playwright MCP can take individual screenshots, but neither
 * pi-agent-core nor any MCP server we use stitches them into a GIF. The repro
 * report's "fix demo" GIF is a hard requirement of the user-facing format,
 * so we ship one ImageMagick-backed tool to handle it.
 */
export function makeStitchGifTool(): AgentTool<typeof StitchGifParams> {
  return {
    name: "stitch_gif",
    label: "Stitch GIF",
    description:
      "Stitch a sequence of PNG screenshots into an animated GIF using ImageMagick `convert`. " +
      "Use this in Phase 2 to produce the demo.gif that proves the fix works (BEFORE → AFTER). " +
      "Requires `convert` (ImageMagick) on PATH.",
    parameters: StitchGifParams,
    execute: async (_id, p: Static<typeof StitchGifParams>) => {
      for (const f of p.inputs) {
        if (!fs.existsSync(f)) {
          throw new Error(`Input not found: ${f}`);
        }
      }
      fs.mkdirSync(path.dirname(p.output_path), { recursive: true });
      const delayCs = Math.round((p.delay_ms_per_frame ?? 1500) / 10); // ImageMagick uses centiseconds
      const width = p.width ?? 960;
      const args = [
        "-delay",
        String(delayCs),
        "-loop",
        "0",
        "-resize",
        `${width}x`,
        ...p.inputs,
        p.output_path,
      ];
      try {
        await execFileAsync("convert", args, { timeout: 60_000 });
      } catch (e) {
        const err = e as Error;
        throw new Error(
          `ImageMagick \`convert\` failed. Is ImageMagick installed?\n${err.message}`
        );
      }
      const stat = fs.statSync(p.output_path);
      return {
        content: [
          {
            type: "text" as const,
            text: `GIF written: ${p.output_path} (${stat.size} bytes, ${p.inputs.length} frames)`,
          },
        ],
        details: {
          path: p.output_path,
          bytes: stat.size,
          frames: p.inputs.length,
        },
      };
    },
  };
}

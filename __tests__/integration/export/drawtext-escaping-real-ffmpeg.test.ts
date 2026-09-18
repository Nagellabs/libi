/**
 * Real-ffmpeg proof that `drawtextSpecFor`'s option values survive BOTH
 * parsers a filtergraph runs them through (graph parser: one level of quoting;
 * option parser: splits on ':' and one level of backslash escaping; drawtext's
 * own text expansion: `\` and `%`).
 *
 * Review of 640e4a59: a font path escaped one level only (`\:`) lost the
 * escape to the graph parser and the colon split the option — "No option
 * name near '\Users\x/Inter-Bold.ttf'", exit 234 — so every ffmpeg-path text
 * export on Windows (whose absolute paths all carry `C:`) failed. The same
 * one-level escaping broke any caption containing an apostrophe ("don't").
 *
 * Each case renders the spec, and a reference that reads the same text from
 * a `textfile` with expansion off and the same font from a plain path; the
 * frames must be byte-identical, which proves the text AND the font arrived
 * exactly as given.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { drawtextSpecFor, quoteFilterValue, type TextOverlayLike } from "@/lib/export/overlay-filter";
import {
  hasFfmpeg,
  hasDrawtext,
  hasDrawtextYAlign,
  FFMPEG_SKIP_REASON,
  DRAWTEXT_SKIP_REASON,
} from "@/__tests__/helpers/media";

const run = promisify(execFile);
const canRun = hasFfmpeg() && hasDrawtext() && hasDrawtextYAlign();
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
else if (!hasDrawtext()) console.info(`[skip] drawtext escaping — ${DRAWTEXT_SKIP_REASON}`);
else if (!hasDrawtextYAlign()) console.info("[skip] drawtext escaping — ffmpeg drawtext has no y_align (needs ≥ 6.1)");
const describeIf = canRun ? describe : describe.skip;

const FONT = path.join(process.cwd(), "public", "fonts", "2d", "Inter-Bold.ttf");
let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-drawtext-esc-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function overlay(content: string): TextOverlayLike {
  return {
    kind: "text", startTime: 0, duration: 1,
    rect: { x: 0, y: 0, width: 400, height: 120 },
    content, font: "48px Inter", color: "#ffffff", align: "center",
  };
}

async function frame(filter: string, cwd?: string): Promise<Buffer> {
  const { stdout } = await run(
    resolveFfmpegPath(),
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=gray:s=400x120",
      "-frames:v", "1", "-filter_complex", `[0:v]${filter}[v]`, "-map", "[v]",
      "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { encoding: "buffer", maxBuffer: 1 << 24, timeout: 20_000, cwd },
  );
  return stdout;
}

/** The same drawtext, but the text from a file with expansion off and the
 *  font from an unremarkable path — what the spec MUST be equivalent to. */
async function reference(content: string): Promise<Buffer> {
  const textfile = path.join(tmp, `ref-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(textfile, content);
  const spec = drawtextSpecFor(overlay("X"), 0, FONT)
    .replace(/^drawtext=text='X'/, `drawtext=textfile=${quoteFilterValue(textfile)}:expansion=none`);
  return frame(spec);
}

/** The spec's frame equals the reference's, and actually has text in it. */
async function expectDrawsExactly(spec: string, content: string): Promise<void> {
  const got = await frame(spec);
  expect(got.reduce((m, v) => Math.max(m, v), 0)).toBeGreaterThan(200); // white ink present
  expect(got).toEqual(await reference(content));
}

function fontIn(dirName: string): string {
  const dir = path.join(tmp, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "Inter-Bold.ttf");
  fs.copyFileSync(FONT, p);
  return p;
}

describeIf("drawtextSpecFor output through real ffmpeg", () => {
  it("a font path containing ':' renders (exit 0) and draws the same font", async () => {
    const p = fontIn("Weird:Path");
    await expectDrawsExactly(drawtextSpecFor(overlay("Hello"), 0, p), "Hello");
  });

  it.skipIf(process.platform === "win32")(
    "a Windows-shaped path component (C:\\Users\\O'Brien) renders and draws the same font",
    async () => {
      const p = fontIn("C:\\Users\\O'Brien");
      await expectDrawsExactly(drawtextSpecFor(overlay("Hello"), 0, p), "Hello");
    },
  );

  it.each([
    "don't",
    "a: b, c; [d]",
    "50% off %{pts}",
    "back\\slash",
    "it's 10:30 — 100%",
  ])("text %j reaches drawtext verbatim", async (content) => {
    await expectDrawsExactly(drawtextSpecFor(overlay(content), 0, FONT), content);
  });

  // Re-review of a46beac8 (IMPORTANT 1): a family that isn't bundled goes to
  // drawtext as `font=<family>`. The CSS list was passed whole, so
  // "Montserrat, sans-serif" put a comma in the graph — the filter ended there
  // and the export failed (exit 234). drawtext gets the FIRST family,
  // unquoted, as a quoted filter value.
  it.each(["64px Montserrat, sans-serif", "64px 'Playfair Display', serif", '64px "A:B", serif'])(
    "a family list %j renders (exit 0)",
    async (font) => {
      const got = await frame(drawtextSpecFor({ ...overlay("Hello"), font }, 0));
      expect(got.reduce((m, v) => Math.max(m, v), 0)).toBeGreaterThan(200);
    },
  );

  // The export names a bundled face by filename and spawns ffmpeg in the
  // fonts dir (Windows command-line length). Same font, same pixels.
  it("a bare bundled filename resolves against the spawn cwd", async () => {
    const spec = drawtextSpecFor(overlay("Hello"), 0, path.basename(FONT));
    expect(await frame(spec, path.dirname(FONT))).toEqual(await reference("Hello"));
  });
});

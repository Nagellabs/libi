/**
 * Windows command-line headroom (QA 2026-09-18 recheck, case 4b): 120 short
 * captions already made a 30.7k-char command line against CreateProcess's
 * 32,767 limit. When the resolved ffmpeg supports `-/<option> <file>` (7.0+;
 * the bundled build is 9.0.1 — `-filter_complex_script` is GONE there), a
 * long graph goes through a file instead of argv. Older ffmpeg keeps the
 * inline form.
 *
 * This builds a real 400-cue caption graph with the export's own
 * buildFilterChain and runs it through the resolved ffmpeg.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { filterGraphArgs, supportsFilterFileOption, INLINE_GRAPH_MAX } from "@/lib/ffmpeg/filter-script";
import { buildFilterChain } from "@/lib/export/backends/ffmpeg-overlay";
import type { Overlay } from "@/lib/engine/types";
import {
  hasFfmpeg, hasDrawtext, hasDrawtextYAlign, FFMPEG_SKIP_REASON, DRAWTEXT_SKIP_REASON,
} from "@/__tests__/helpers/media";

const run = promisify(execFile);
const canRun = hasFfmpeg() && hasDrawtext() && hasDrawtextYAlign();
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
else if (!hasDrawtext()) console.info(`[skip] filter graph file — ${DRAWTEXT_SKIP_REASON}`);
const describeIf = canRun ? describe : describe.skip;

const FONTS_DIR = path.join(process.cwd(), "public", "fonts", "2d");
let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function cues(n: number): Overlay[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `cue${i}`, kind: "text", startTime: i * 0.04, duration: 0.04, z: i + 1, opacity: 1,
    rect: { x: 90, y: 1500, width: 900, height: 200 }, content: `Cue ${i}: don't a:b 50%`,
    font: "48px Inter", fontSize: 64, fontWeight: 700, color: "#ffffff", align: "center",
    stroke: { color: "#000000", width: 6 },
  })) as unknown as Overlay[];
}

describeIf("long filter graphs through a file", () => {
  it("a 400-cue caption graph runs through the resolved ffmpeg", async () => {
    const overlays = cues(400);
    const graph = buildFilterChain(overlays, new Map(), { width: 1080, height: 1920 },
      new Map(overlays.map((o) => [o.id, "Inter-Bold.ttf"])));
    expect(graph.length).toBeGreaterThan(40_000); // well past Windows' limit inline
    expect(graph.length).toBeGreaterThan(INLINE_GRAPH_MAX);

    const supported = await supportsFilterFileOption();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-graph-"));
    const graphArgs = await filterGraphArgs(graph, tmp, supported);
    if (supported) {
      expect(graphArgs[0]).toBe("-/filter_complex");
      expect(fs.readFileSync(graphArgs[1], "utf-8")).toBe(graph);
    } else {
      expect(graphArgs).toEqual(["-filter_complex", graph]);
    }
    const argv = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=gray:s=1080x1920:d=16:r=25",
      ...graphArgs, "-map", "[vout]", "-f", "null", "-"];
    if (supported) expect(argv.join(" ").length).toBeLessThan(1_000);
    await expect(run(resolveFfmpegPath(), argv, { cwd: FONTS_DIR, timeout: 120_000 })).resolves.toBeDefined();
  }, 150_000);

  it("the support probe answers once per ffmpeg binary", async () => {
    const a = supportsFilterFileOption();
    expect(supportsFilterFileOption()).toBe(a);
    expect(typeof (await a)).toBe("boolean");
  });
});

describe("filterGraphArgs", () => {
  it("keeps a short graph inline even when files are supported", async () => {
    expect(await filterGraphArgs("[0:v]null[vout]", os.tmpdir(), true)).toEqual(["-filter_complex", "[0:v]null[vout]"]);
  });
  it("keeps a long graph inline when the ffmpeg can't read it from a file", async () => {
    const g = "x".repeat(INLINE_GRAPH_MAX + 1);
    expect(await filterGraphArgs(g, os.tmpdir(), false)).toEqual(["-filter_complex", g]);
  });
});

/**
 * The ffmpeg-overlay export, run end to end with the REAL ffmpeg, keeps overlay
 * colours the way the preview shows them on an UNTAGGED HD base — and never
 * moves a base pixel.
 *
 * "The way a player shows it" is decoded here by the convention browsers and
 * QuickTime use (measured in docs-local/superpowers/plans/backlog-task-1-report.md):
 * a tagged stream by its tag; an untagged one as BT.709 when HD, BT.601 when
 * SD. ffmpeg's own default (untagged ⇒ 601 at any size) is NOT that, which is
 * why a tag-aware ffmpeg read alone never saw the bug.
 *
 * Every source here is BT.601-encoded; the untagged ones carry no tags, which
 * is what ffmpeg itself writes by default.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { hasFfmpeg, hasDrawtext, hasDrawtextYAlign, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";
import type { Composition, Overlay } from "@/lib/engine/types";

const run = promisify(execFile);

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let storageDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(storageDir) }));
// libx264 everywhere: the hardware encoder probe is host-dependent.
vi.mock("@/lib/export/hw-accel", async (orig) => ({
  ...(await orig<typeof import("@/lib/export/hw-accel")>()),
  detectAvailableEncoders: async () => new Set<string>(),
}));

import { FfmpegOverlayBackend, buildFilterChain } from "@/lib/export/backends/ffmpeg-overlay";
import { drawtextSpecFor, plateSpecFor } from "@/lib/export/overlay-filter";
import { layoutTextForExport } from "@/lib/export/text-export-layout";
import { createServerTextMeasurer } from "@/lib/export/text-measure-server";

/**
 * Does this ffmpeg convert an RGB overlay with the frame's DECLARED matrix?
 * Colourspace-aware format negotiation arrived in ffmpeg 7.1; before it, the
 * auto-inserted converter used BT.601 whatever the frame said, so the fix
 * cannot take effect (it changes nothing there either). Probed by doing it:
 * pure green over a 709-declared frame must come out with 709's U (≈42), not
 * 601's (≈54).
 */
function convertsWithDeclaredMatrix(): boolean {
  try {
    const out = execFileSync(resolveFfmpegPath(), [
      "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=16x16:d=0.04",
      "-f", "lavfi", "-i", "color=c=0x00ff00:s=16x16:d=0.04,format=rgba",
      "-filter_complex", "[0:v]format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709[b];[b][1:v]overlay,format=yuv420p",
      "-frames:v", "1", "-f", "rawvideo", "-",
    ], { timeout: 10_000 });
    return Math.abs(out[256] - 42) <= 2; // first U sample
  } catch {
    return false;
  }
}

const canRun = hasFfmpeg();
if (!canRun) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const colourAware = canRun && convertsWithDeclaredMatrix();
if (canRun && !colourAware) {
  console.info("[skip] overlay-colour assertions — this ffmpeg converts overlays with BT.601 regardless of the frame (< 7.1)");
}
const itColour = colourAware ? it : it.skip;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-untagged-color-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const UNTAG = "setparams=color_primaries=unknown:color_trc=unknown:colorspace=unknown:range=unknown";
const TAG601 = "setparams=color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m:range=tv";
const TAG709 = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";

/** A clip of saturated bars (red, green, blue, yellow) encoded with BT.601. */
async function barsClip(name: string, w: number, h: number, tags: string, matrix = "bt601"): Promise<string> {
  const out = path.join(tmp, name);
  const bw = w / 4;
  const bars = ["0xFF0000", "0x00FF00", "0x0000FF", "0xFFFF00"]
    .map((c, i) => `drawbox=x=${i * bw}:y=0:w=${bw}:h=${h}:c=${c}:t=fill`).join(",");
  await run(resolveFfmpegPath(), [
    "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${w}x${h}:d=0.5:r=10,format=rgb24,${bars}`,
    "-vf", `scale=out_color_matrix=${matrix}:out_range=tv,format=yuv420p,${tags}`,
    "-c:v", "libx264", "-crf", "10", out,
  ]);
  return out;
}

async function probeTags(file: string): Promise<{ colorSpace: string; w: number; h: number }> {
  const { stdout } = await run(resolveFfprobePath(), [
    "-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height,color_space", "-of", "json", file,
  ]);
  const s = JSON.parse(stdout).streams[0];
  return { colorSpace: s.color_space ?? "unknown", w: s.width, h: s.height };
}

/** Decode frame 0 to RGB the way a player shows it (see the header). */
async function playerRgb(file: string): Promise<{ w: number; at: (x: number, y: number) => number[] }> {
  const t = await probeTags(file);
  const matrix = t.colorSpace !== "unknown" ? t.colorSpace : t.w >= 1280 || t.h >= 720 ? "bt709" : "bt601";
  const { stdout } = await run(resolveFfmpegPath(), [
    "-v", "error", "-i", file, "-frames:v", "1",
    "-vf", `scale=in_color_matrix=${matrix === "smpte170m" || matrix === "bt470bg" ? "bt601" : matrix}:in_range=tv,format=rgb24`,
    "-f", "rawvideo", "-",
  ], { encoding: "buffer", maxBuffer: 1 << 26 });
  const b = stdout as unknown as Buffer;
  return { w: t.w, at: (x, y) => { const o = (y * t.w + x) * 3; return [b[o], b[o + 1], b[o + 2]]; } };
}

/** Frame 0's raw Y/U/V at (x, y) — no conversion at all. */
async function rawYuv(file: string): Promise<(x: number, y: number) => number[]> {
  const t = await probeTags(file);
  const { stdout } = await run(resolveFfmpegPath(), [
    "-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-",
  ], { encoding: "buffer", maxBuffer: 1 << 26 });
  const b = stdout as unknown as Buffer;
  const { w, h } = t;
  return (x, y) => [b[y * w + x], b[w * h + (y >> 1) * (w >> 1) + (x >> 1)], b[w * h * 1.25 + (y >> 1) * (w >> 1) + (x >> 1)]];
}

const near = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

let greenPng: string;
let hdOverlayClip: string;
beforeAll(async () => {
  if (!canRun) return;
  greenPng = path.join(tmp, "green.png");
  await run(resolveFfmpegPath(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x00FF00:s=64x64,format=rgba", "-frames:v", "1", greenPng]);
  hdOverlayClip = await barsClip("ovl-hd-untagged.mp4", 1280, 720, UNTAG);
}, 60_000);

beforeEach(() => {
  storageDir = fs.mkdtempSync(path.join(tmp, "store-"));
  testDb = createTestDb();
  seedPiece(testDb, { id: "p" });
  fs.mkdirSync(path.join(storageDir, "p"), { recursive: true });
});

/**
 * Export `base` (w×h) with a pure-green PNG square at (w/2−32, 8) and the
 * untagged 720p bars clip as a video overlay in the top-left quarter. The base
 * itself stays visible along the bottom rows.
 */
async function exportOver(base: string, w: number, h: number, outDims = { w, h }): Promise<string> {
  const put = (id: string, src: string, type: string) => {
    const filename = `${id}${path.extname(src)}`;
    fs.copyFileSync(src, path.join(storageDir, "p", filename));
    testDb.insert(files).values({
      id, pieceId: "p", filename, name: id, description: "", type, storagePath: `p/${filename}`, size: 1,
    }).run();
  };
  put("base", base, "video");
  put("png", greenPng, "image");
  put("vid", hdOverlayClip, "video");
  const out = path.join(storageDir, "out.mp4");
  const composition = {
    id: "c", name: "c", width: w, height: h, fps: 10,
    overlays: [
      { id: "b", kind: "video", fileId: "base", videoUrl: "", startTime: 0, duration: 0.5, z: 0, opacity: 1,
        fit: "cover", rect: { x: 0, y: 0, width: w, height: h }, trim: { start: 0, end: 0.5 } },
      { id: "sq", kind: "image", fileId: "png", startTime: 0, duration: 0.5, z: 1, opacity: 1,
        rect: { x: w / 2 - 32, y: 8, width: 64, height: 64 } },
      { id: "v", kind: "video", fileId: "vid", videoUrl: "", startTime: 0, duration: 0.5, z: 2, opacity: 1,
        fit: "cover", rect: { x: 0, y: 0, width: w / 4, height: (w / 4) * 9 / 16 } },
    ],
  } as unknown as Composition;
  await new FfmpegOverlayBackend().run({
    composition,
    settings: { format: "mp4", codec: "avc", bitrate: 20_000_000, width: outDims.w, height: outDims.h, fps: 10 },
    outputPath: out,
  });
  return out;
}

/** The base must reach the output with its YUV untouched (bottom rows, bar centres). */
async function expectBaseUntouched(src: string, out: string, w: number, h: number) {
  const a = await rawYuv(src);
  const b = await rawYuv(out);
  for (let i = 0; i < 4; i++) {
    const x = Math.round((i + 0.5) * (w / 4));
    expect(near(b(x, h - 8), a(x, h - 8), 3), `base bar ${i}: ${b(x, h - 8)} vs ${a(x, h - 8)}`).toBe(true);
  }
}

/** The video overlay must look in the output as its own file looks in a player. */
async function expectVideoOverlayAsPlayerShowsIt(out: string, w: number) {
  const ref = await playerRgb(hdOverlayClip);
  const got = await playerRgb(out);
  const rw = w / 4;
  const rh = rw * 9 / 16;
  for (let i = 0; i < 4; i++) {
    const want = ref.at(Math.round((i + 0.5) * 320), 360);
    const have = got.at(Math.round((i + 0.5) * (rw / 4)), Math.round(rh / 2));
    expect(near(have, want, 6), `overlay-video bar ${i}: ${have} vs ${want}`).toBe(true);
  }
}

describe.skipIf(!canRun)("ffmpeg-overlay export — colour of an untagged HD base (real ffmpeg)", () => {
  itColour("untagged 1080p: the output is tagged BT.709, the green square plays as 0,255,0, the base is untouched", async () => {
    const src = await barsClip("base-untagged-1080.mp4", 1920, 1080, UNTAG);
    const out = await exportOver(src, 1920, 1080);
    expect((await probeTags(out)).colorSpace).toBe("bt709");
    const px = (await playerRgb(out)).at(960, 40);
    expect(near(px, [0, 255, 0], 4), `square reads ${px}`).toBe(true);
    await expectBaseUntouched(src, out, 1920, 1080);
    await expectVideoOverlayAsPlayerShowsIt(out, 1920);
  }, 120_000);

  itColour("tagged BT.709: tags carried through, square exact, base untouched, untagged HD overlay video as players show it", async () => {
    const src = await barsClip("base-709.mp4", 1920, 1080, TAG709, "bt709");
    const out = await exportOver(src, 1920, 1080);
    expect((await probeTags(out)).colorSpace).toBe("bt709");
    const px = (await playerRgb(out)).at(960, 40);
    expect(near(px, [0, 255, 0], 4), `square reads ${px}`).toBe(true);
    await expectBaseUntouched(src, out, 1920, 1080);
    await expectVideoOverlayAsPlayerShowsIt(out, 1920);
  }, 120_000);

  itColour("tagged smpte170m: tags carried through, square exact, base untouched", async () => {
    const src = await barsClip("base-601.mp4", 1920, 1080, TAG601);
    const out = await exportOver(src, 1920, 1080);
    expect((await probeTags(out)).colorSpace).toBe("smpte170m");
    const px = (await playerRgb(out)).at(960, 40);
    expect(near(px, [0, 255, 0], 4), `square reads ${px}`).toBe(true);
    await expectBaseUntouched(src, out, 1920, 1080);
    await expectVideoOverlayAsPlayerShowsIt(out, 1920);
  }, 120_000);

  it("untagged 640×480: left untagged as today, square exact under the SD reading, base untouched", async () => {
    const src = await barsClip("base-untagged-sd.mp4", 640, 480, UNTAG);
    const out = await exportOver(src, 640, 480);
    expect((await probeTags(out)).colorSpace).toBe("unknown");
    const px = (await playerRgb(out)).at(320, 40);
    expect(near(px, [0, 255, 0], 4), `square reads ${px}`).toBe(true);
    await expectBaseUntouched(src, out, 640, 480);
  }, 120_000);
});

/**
 * The base must look in the output (read as a player reads the output) the way
 * its own file looks in a player — at the bottom rows' bar centres. For an SD
 * source scaled up this is a colour comparison, not a YUV one: the base's
 * matrix changes on the way.
 */
async function expectBaseAsPlayerShowsIt(src: string, out: string, w: number, h: number, ow: number, oh: number) {
  const a = await playerRgb(src);
  const b = await playerRgb(out);
  for (let i = 0; i < 4; i++) {
    const want = a.at(Math.round((i + 0.5) * (w / 4)), h - 8);
    const have = b.at(Math.round((i + 0.5) * (ow / 4)), Math.round(((h - 8) * oh) / h));
    expect(near(have, want, 3), `base bar ${i}: ${have} vs ${want}`).toBe(true);
  }
}

// QA 2026-09-19 Q1: text/code/3D raise the output to at least 1080p, so an SD
// clip with a caption exports at HD size. It used to stay untagged BT.601 —
// and untagged HD is BT.709 to every player: base Δ30, green 0,214,0.
describe.skipIf(!canRun)("ffmpeg-overlay export — untagged SD base at HD output size (real ffmpeg)", () => {
  for (const [label, ow, oh] of [["1440×1080", 1440, 1080], ["4K (2880×2160)", 2880, 2160]] as const) {
    itColour(`640×480 → ${label}: tagged BT.709, square 0,255,0, base and video overlay as players show them`, async () => {
      const src = await barsClip("base-untagged-sd-up.mp4", 640, 480, UNTAG);
      const out = await exportOver(src, 640, 480, { w: ow, h: oh });
      const t = await probeTags(out);
      expect([t.w, t.h, t.colorSpace]).toEqual([ow, oh, "bt709"]);
      const px = (await playerRgb(out)).at(ow / 2, Math.round((40 * oh) / 480));
      expect(near(px, [0, 255, 0], 4), `square reads ${px}`).toBe(true);
      await expectBaseAsPlayerShowsIt(src, out, 640, 480, ow, oh);
      await expectVideoOverlayAsPlayerShowsIt(out, ow);
    }, 120_000);
  }

  itColour("a TAGGED smpte170m SD base at HD size keeps its own tags (players honour them), square exact", async () => {
    const src = await barsClip("base-601-sd-up.mp4", 640, 480, TAG601);
    const out = await exportOver(src, 640, 480, { w: 1440, h: 1080 });
    expect((await probeTags(out)).colorSpace).toBe("smpte170m");
    const px = (await playerRgb(out)).at(720, 90);
    expect(near(px, [0, 255, 0], 4), `square reads ${px}`).toBe(true);
    await expectBaseAsPlayerShowsIt(src, out, 640, 480, 1440, 1080);
  }, 120_000);
});

// ─── Task 1b: text plates ────────────────────────────────────────────────────
// A plate used to be `drawbox` straight onto the YUV frame, which converts its
// colour with BT.601 whatever the frame declares. It is now drawn on an RGBA
// layer and composited with `overlay` (lib/export/overlay-filter.ts
// #plateLayerSegments), which uses the frame's matrix.

const canText = canRun && hasDrawtext() && hasDrawtextYAlign();
const FONTS_DIR = path.join(process.cwd(), "public", "fonts", "2d");
const FACE = "Inter-Bold.ttf";
const SETPARAMS_709 = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709";

function caption(extra: Record<string, unknown> = {}): Overlay {
  return {
    id: "cap", kind: "text", startTime: 0, duration: 1, z: 1, opacity: 1,
    rect: { x: 100, y: 700, width: 1720, height: 200 }, anchor: "mid-center",
    position: { x: 960, y: 800 }, content: "Plate", font: "72px Inter", fontSize: 72, fontWeight: 700,
    color: "#ffffff", align: "center",
    background: { color: "#00ff00", padding: 24, radius: 8 },
    ...extra,
  } as unknown as Overlay;
}

/** Render `graph` over a gray 1920×1080 base with the given tags; LOSSLESS
 *  libx264 (-qp 0), so two graphs compare pixel for pixel. */
async function renderGraph(graph: string, baseTags: string, name: string): Promise<string> {
  const out = path.join(tmp, name);
  await run(resolveFfmpegPath(), [
    "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x606060:s=1920x1080:d=0.4:r=10,format=yuv420p,${baseTags}`,
    "-filter_complex", graph, "-map", "[vout]", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", out,
  ], { cwd: FONTS_DIR, timeout: 60_000 });
  return out;
}

function exportGraph(o: Overlay, baseColorParams?: string): string {
  const measurer = createServerTextMeasurer(o as never, path.join(FONTS_DIR, FACE));
  return buildFilterChain([o], new Map(), { width: 1920, height: 1080, baseColorParams }, new Map([[o.id, FACE]]), () => measurer);
}

/** Today's graph (before Task 1b): the plate drawboxed onto the frame, then the text. */
function legacyGraph(o: Overlay): string {
  const measurer = createServerTextMeasurer(o as never, path.join(FONTS_DIR, FACE));
  const layout = layoutTextForExport(o as never, 1920, measurer);
  return `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1[base];` +
    `[base]${plateSpecFor(o as never, layout, 0, 1)},${drawtextSpecFor(o as never, 0, FACE, 1, layout)}[vout]`;
}

/** A point inside the plate but clear of the glyphs: its left padding. */
function platePoint(o: Overlay): [number, number] {
  const measurer = createServerTextMeasurer(o as never, path.join(FONTS_DIR, FACE));
  const p = layoutTextForExport(o as never, 1920, measurer).plate!;
  return [Math.round(p.x + 6), Math.round(p.y + p.height / 2)];
}

describe.skipIf(!canText)("ffmpeg-overlay export — text plate colour and geometry (real ffmpeg)", () => {
  itColour("a green plate plays as 0,255,0 on an untagged HD base (declared 709) and on a tagged 709 base", async () => {
    const o = caption();
    const [x, y] = platePoint(o);
    for (const [name, tags, params] of [
      ["plate-untagged.mp4", UNTAG, SETPARAMS_709],
      ["plate-709.mp4", TAG709, undefined],
    ] as const) {
      const out = await renderGraph(exportGraph(o, params), tags, name);
      expect((await probeTags(out)).colorSpace).toBe("bt709");
      const px = (await playerRgb(out)).at(x, y);
      expect(near(px, [0, 255, 0], 4), `${name}: plate reads ${px}`).toBe(true);
      // …where today's drawbox painted it 601-coded: 0,215,0 on the same base
      const old = (await playerRgb(await renderGraph(legacyGraph(o).replace("[0:v]", `[0:v]${params ? `${params},` : ""}`), tags, `old-${name}`))).at(x, y);
      expect(old[1]).toBeLessThan(230);
    }
  }, 120_000);

  it("geometry and blending are pixel-identical to today's drawbox for neutral plates (radius ≤ 8, padding, opacity)", async () => {
    for (const [n, extra] of [
      [0, { background: { color: "rgba(0,0,0,0.6)", padding: 13, radius: 8 } }],
      [1, { background: { color: "#ffffff", padding: 7, radius: 0 }, rect: { x: 101, y: 701, width: 1719, height: 199 }, position: { x: 961, y: 801 } }],
      [2, { background: { color: "#000000", padding: 24 }, opacity: 0.5 }],
    ] as const) {
      const o = caption(extra as Record<string, unknown>);
      const a = await rawYuv(await renderGraph(exportGraph(o), UNTAG, `geo-new-${n}.mp4`));
      const b = await rawYuv(await renderGraph(legacyGraph(o), UNTAG, `geo-old-${n}.mp4`));
      let worst = 0;
      let where = "";
      for (let yy = 0; yy < 1080; yy += 1) {
        for (let xx = 0; xx < 1920; xx += 1) {
          const d = Math.abs(a(xx, yy)[0] - b(xx, yy)[0]);
          if (d > worst) { worst = d; where = `${xx},${yy} new=${a(xx, yy)} old=${b(xx, yy)}`; }
        }
      }
      expect(worst, `case ${n}: max luma difference at ${where}`).toBeLessThanOrEqual(1);
    }
  }, 180_000);
});

// ─── Task 1b fix: cue boundaries are half-open, like the preview ─────────────
// Touching caption cues share a run and its plate layer. ffmpeg's `between` is
// inclusive at both ends, so the frame exactly on the boundary used to enable
// BOTH cues' plates and texts — they overprinted for a frame. The preview shows
// only the new cue there (`time >= start && time < start + duration`).

/** Every frame of `graph` over a 640×360 gray base at 30 fps, 1 s, as raw yuv420p. */
async function renderFrames(graph: string): Promise<Buffer[]> {
  const { stdout } = await run(resolveFfmpegPath(), [
    "-v", "error", "-f", "lavfi", "-i", "color=c=0x606060:s=640x360:d=1:r=30,format=yuv420p",
    "-filter_complex", graph, "-map", "[vout]", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-",
  ], { cwd: FONTS_DIR, encoding: "buffer", maxBuffer: 1 << 27, timeout: 60_000 });
  const b = stdout as unknown as Buffer;
  const size = 640 * 360 * 1.5;
  return Array.from({ length: b.length / size }, (_, i) => b.subarray(i * size, (i + 1) * size));
}

function cue(id: string, content: string, startTime: number, duration: number): Overlay {
  return {
    id, kind: "text", startTime, duration, z: 1, opacity: 1,
    rect: { x: 40, y: 250, width: 560, height: 80 }, anchor: "mid-center", position: { x: 320, y: 290 },
    content, font: "40px Inter", fontSize: 40, fontWeight: 700, color: "#ffffff", align: "center",
    background: { color: "#00ff00", padding: 10 },
  } as unknown as Overlay;
}

function cuesGraph(cues: Overlay[]): string {
  return buildFilterChain(cues, new Map(), { width: 640, height: 360 }, new Map(cues.map((c) => [c.id, FACE])), (o) =>
    createServerTextMeasurer(o as never, path.join(FONTS_DIR, FACE)));
}

describe.skipIf(!canText)("ffmpeg-overlay export — cue boundaries (real ffmpeg)", () => {
  it("the frame on a boundary shows ONLY the new cue, and a cue ending at the export end shows on the last frame", async () => {
    const a = cue("a", "AAAA", 0, 0.5);
    const b = cue("b", "WWWWWW", 0.5, 0.5);
    const both = await renderFrames(cuesGraph([a, b]));
    const onlyA = await renderFrames(cuesGraph([cue("a", "AAAA", 0, 1)]));
    const onlyB = await renderFrames(cuesGraph([cue("b", "WWWWWW", 0, 1)]));
    expect(both).toHaveLength(30);
    // Luma: the chroma sample straddling a plate edge at an odd x depends on
    // the layer's extent (4:2:0), which differs between these graphs.
    const Y = (f: Buffer) => f.subarray(0, 640 * 360);
    expect(Y(both[14]).equals(Y(onlyA[14])), "frame 14 (t≈0.467) is cue A alone").toBe(true);
    expect(Y(both[15]).equals(Y(onlyB[15])), "frame 15 (t=0.5) is cue B alone, not A over B").toBe(true);
    expect(Y(both[29]).equals(Y(onlyB[29])), "frame 29 (t≈0.967, the last) still shows cue B").toBe(true);
    const bare = await renderFrames("[0:v]null[vout]");
    expect(Y(both[29]).equals(Y(bare[29])), "…and cue B is really drawn there").toBe(false);
  }, 120_000);
});

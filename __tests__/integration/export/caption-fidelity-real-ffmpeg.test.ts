/**
 * The ffmpeg-overlay export's caption, drawn by the REAL ffmpeg, lands where the
 * preview lays it out: the line breaks, each line's ink box, the blurred
 * shadow and the background plate — at 1080×1920 and at 4K (2160×3840, the
 * same 1080-wide composition scaled 2×).
 *
 * The reference is the preview's layout math (layoutTextForExport — the
 * renderer's wrap / block centring / plate geometry) with the SAME font file
 * drawtext loads, measured by @napi-rs/canvas. The side-by-side against the
 * chromium renderer's own pixels is in the Task 2 report
 * (.superpowers/sdd/cap-task-2-report.md) — @napi-rs/canvas can't stand in for
 * it here: its `textBaseline: "top"` is not Chromium's em-box top.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadImage, createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { buildFilterChain } from "@/lib/export/backends/ffmpeg-overlay";
import { layoutTextForExport } from "@/lib/export/text-export-layout";
import { createServerTextMeasurer } from "@/lib/export/text-measure-server";
import type { Overlay } from "@/lib/engine/types";
import {
  hasFfmpeg, hasDrawtext, hasDrawtextYAlign, FFMPEG_SKIP_REASON, DRAWTEXT_SKIP_REASON,
} from "@/__tests__/helpers/media";

const run = promisify(execFile);
const canRun = hasFfmpeg() && hasDrawtext() && hasDrawtextYAlign();
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
else if (!hasDrawtext()) console.info(`[skip] caption fidelity — ${DRAWTEXT_SKIP_REASON}`);
const describeIf = canRun ? describe : describe.skip;

const FONTS_DIR = path.join(process.cwd(), "public", "fonts", "2d");
const FACE = "Inter-Bold.ttf";
const W = 1080;
const H = 1920;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-caption-fidelity-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The QA caption: 58 characters, portrait. */
const CAPTION = "This caption is long enough that it must wrap in portrait.";

function caption(extra: Record<string, unknown> = {}): Overlay {
  return {
    id: "cap", kind: "text", startTime: 0, duration: 1, z: 1, opacity: 1,
    // generate_captions' shape: anchored, wrapped at 90% of the frame.
    rect: { x: 40, y: 1400, width: 1000, height: 260 },
    anchor: "mid-center", position: { x: 540, y: 1530 }, maxWidthPct: 0.9,
    content: CAPTION, font: "48px Inter", fontSize: 72, fontWeight: 700,
    color: "#ffffff", align: "center",
    // Loose enough that one line's descenders never share a pixel row with
    // the next line's ascenders, so lines can be told apart by rows.
    lineHeight: 1.6, ...extra,
  } as unknown as Overlay;
}

/** Render one frame of `o` over flat gray with the export's own graph. */
async function renderFfmpeg(o: Overlay, scale: number, baseColor = "0x808080"): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const tw = W * scale;
  const th = H * scale;
  const measurer = createServerTextMeasurer(o as never, path.join(FONTS_DIR, FACE));
  const graph = buildFilterChain(
    [o], new Map(), { width: W, height: H, targetWidth: tw, targetHeight: th },
    new Map([[o.id, FACE]]), () => measurer,
  );
  const out = path.join(tmp, `${o.id}-${Math.random().toString(36).slice(2)}.png`);
  await run(resolveFfmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${baseColor}:s=${W}x${H}:d=1:r=10`,
    "-filter_complex", graph, "-map", "[vout]", "-ss", "0.5", "-frames:v", "1", out,
  ], { cwd: FONTS_DIR, timeout: 60_000 });
  const img = await loadImage(fs.readFileSync(out));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
}

/** Rows/cols whose pixels pass `hit`, as maximal runs of rows ("bands"). */
function bands(f: { data: Uint8ClampedArray; w: number; h: number }, hit: (r: number, g: number, b: number) => boolean) {
  const rows: { y: number; minX: number; maxX: number }[] = [];
  for (let y = 0; y < f.h; y++) {
    let minX = Infinity;
    let maxX = -1;
    for (let x = 0; x < f.w; x++) {
      const i = (y * f.w + x) * 4;
      if (hit(f.data[i], f.data[i + 1], f.data[i + 2])) {
        if (x < minX) minX = x;
        maxX = x;
      }
    }
    if (maxX >= 0) rows.push({ y, minX, maxX });
  }
  const out: { top: number; bottom: number; minX: number; maxX: number }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && r.y === last.bottom + 1) {
      last.bottom = r.y;
      last.minX = Math.min(last.minX, r.minX);
      last.maxX = Math.max(last.maxX, r.maxX);
    } else out.push({ top: r.y, bottom: r.y, minX: r.minX, maxX: r.maxX });
  }
  return out;
}

const white = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;

/** A line's INK width (actualBoundingBoxLeft + Right) in the face drawtext
 *  loads — the advance width the layout wraps with includes side bearings. */
GlobalFonts.registerFromPath(path.join(FONTS_DIR, FACE), "fidelity-inter-bold");
const inkCtx = createCanvas(1, 1).getContext("2d");
inkCtx.font = '72px "fidelity-inter-bold"';
function inkWidth(line: string): number {
  const m = inkCtx.measureText(line);
  return m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
}

describeIf.each([1, 2])("caption fidelity against the preview layout — scale %i", (scale) => {
  const tol = 3 * scale;

  it("the 58-char caption wraps into the preview's lines, each centred on the rect, ink where the layout puts it", async () => {
    const o = caption();
    const measurer = createServerTextMeasurer(o as never, path.join(FONTS_DIR, FACE));
    const layout = layoutTextForExport(o as never, W, measurer);
    expect(layout.lines.length).toBeGreaterThanOrEqual(2);

    const f = await renderFfmpeg(o, scale);
    const lines = bands(f, white);
    expect(lines).toHaveLength(layout.lines.length);
    const centreX = (40 + 500) * scale;
    lines.forEach((band, i) => {
      // horizontally centred on the rect's middle
      expect(Math.abs((band.minX + band.maxX + 1) / 2 - centreX)).toBeLessThanOrEqual(tol);
      // as wide as the line's ink in that face
      expect(Math.abs((band.maxX - band.minX + 1) - inkWidth(layout.lines[i]) * scale)).toBeLessThanOrEqual(tol);
      // ink top where the preview draws it: line top − ink ascent
      const lineTop = layout.blockTop + i * layout.lineHeightPx;
      const { ascent, descent } = measurer.ink(layout.lines[i]);
      expect(Math.abs(band.top - (lineTop - ascent) * scale)).toBeLessThanOrEqual(tol);
      expect(Math.abs(band.bottom + 1 - (lineTop + descent) * scale)).toBeLessThanOrEqual(tol);
    });
  }, 60_000);

  it("a blurred shadow falls below the text and fades out (not drawtext's hard edge)", async () => {
    const o = caption({ content: "Shadow", shadow: { color: "rgba(0,0,0,0.9)", blur: 12, dx: 0, dy: 12 } });
    const f = await renderFfmpeg(o, scale);
    const [text] = bands(f, white);
    // a column through the middle of the text: walk down from the ink bottom
    const x = Math.round((text.minX + text.maxX) / 2);
    const lum = (y: number) => f.data[(y * f.w + x) * 4];
    const below = [...Array(Math.round(30 * scale)).keys()].map((k) => lum(text.bottom + 1 + k));
    // darker than the 128 gray right under the text, back to gray further down
    expect(Math.min(...below.slice(0, Math.round(10 * scale)))).toBeLessThan(110);
    expect(lum(text.bottom + Math.round(40 * scale))).toBeGreaterThan(122);
    // soft: several intermediate levels between the darkest and the gray
    const levels = new Set(below.filter((v) => v > 20 && v < 120));
    expect(levels.size).toBeGreaterThanOrEqual(4);
  }, 60_000);

  // The canvas draws a shadow at shadowColor alpha × globalAlpha, ONCE. The
  // layer used to apply the colour alpha twice (0.55 → ≈0.30).
  it("a shadow's alpha is applied once: α 0.5 darkens half as much as α 1", async () => {
    const peak = async (alpha: number) => {
      const o = caption({ id: `a${alpha}`, content: "Shadow", color: "#808080",
        shadow: { color: `rgba(0,0,0,${alpha})`, blur: 12, dx: 0, dy: 40 } });
      const f = await renderFfmpeg(o, scale);
      let min = 255;
      for (let i = 0; i < f.data.length; i += 4) min = Math.min(min, f.data[i]);
      return 128 - min;
    };
    const full = await peak(1);
    const half = await peak(0.5);
    expect(full).toBeGreaterThan(40);
    expect(half / full).toBeGreaterThan(0.45);
    expect(half / full).toBeLessThan(0.55);
  }, 60_000);

  // The mask branch's `format=gray` used to negotiate back through the split
  // to the base's scale — the whole export came out grayscale. A gray test
  // base can't show that; a red one can.
  it("a shadowed caption leaves the rest of the frame in colour", async () => {
    const o = caption({ id: "colour", content: "Colour", shadow: { color: "rgba(0,0,0,0.55)", blur: 8, dx: 0, dy: 2 } });
    const f = await renderFfmpeg(o, scale, "0xd02020");
    const at = (x: number, y: number) => [...f.data.slice((y * f.w + x) * 4, (y * f.w + x) * 4 + 3)];
    const [r, g, b] = at(10 * scale, 10 * scale);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
  }, 60_000);

  it("the background plate is ONE box around the block, where the preview puts it", async () => {
    const o = caption({ background: { color: "#102030", padding: 14, radius: 6 } });
    const measurer = createServerTextMeasurer(o as never, path.join(FONTS_DIR, FACE));
    const layout = layoutTextForExport(o as never, W, measurer);
    const f = await renderFfmpeg(o, scale);
    const plate = bands(f, (r, g, b) => Math.abs(r - 0x10) < 12 && Math.abs(g - 0x20) < 12 && Math.abs(b - 0x30) < 12);
    // one contiguous box (the text inside doesn't split it: its columns still hit)
    expect(plate).toHaveLength(1);
    const p = layout.plate!;
    expect(Math.abs(plate[0].top - p.y * scale)).toBeLessThanOrEqual(tol);
    expect(Math.abs(plate[0].bottom + 1 - (p.y + p.height) * scale)).toBeLessThanOrEqual(tol);
    expect(Math.abs(plate[0].minX - p.x * scale)).toBeLessThanOrEqual(tol);
    expect(Math.abs(plate[0].maxX + 1 - (p.x + p.width) * scale)).toBeLessThanOrEqual(tol);
  }, 60_000);
});

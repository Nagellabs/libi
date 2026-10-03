// Next.js-SERVER-ONLY (uses @napi-rs/canvas). The picture half of `libi.render_overlay_frames`: a region
// crop in composition pixels, a size cap, and ONE labelled contact sheet that can span several pieces.
// Pure geometry (`clampRegion`, `regionShortSide`, `chooseGrid`) is split from the drawing so it tests
// without a canvas; nothing here reads a piece or renders a frame.
import { createCanvas, type Canvas, type Image } from "@napi-rs/canvas";
import { ensureBundledFontsRegistered } from "@/lib/fonts/register-server";

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A sheet's longest edge unless the caller says otherwise: ~1.1K image tokens where the old 1600-wide sheet cost ~3K. */
export const DEFAULT_SHEET_MAX_EDGE = 1024;
const SHEET_JPEG_QUALITY = 85; // @napi-rs/canvas jpeg quality is 0-100, not 0-1.

/**
 * The part of `region` that lies inside the composition, in whole pixels, or null when none of it does.
 * `clipped` says it was cut, so the result can tell the agent it did not get exactly what it asked for.
 */
export function clampRegion(region: Region, compW: number, compH: number): { region: Region; clipped: boolean } | null {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(compW, Math.ceil(region.x + region.width));
  const y1 = Math.min(compH, Math.ceil(region.y + region.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const out = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const clipped = out.x !== region.x || out.y !== region.y || out.width !== region.width || out.height !== region.height;
  return { region: out, clipped };
}

/**
 * The `maxShortSide` to render a frame at so that `region` comes out with enough pixels to read small text
 * (its longest edge ~`wantEdge`), never below the usual verify size and never above the composition itself.
 */
export function regionShortSide(region: Region, compW: number, compH: number, base = 720, wantEdge = 900): number {
  const short = Math.min(compW, compH);
  const scale = Math.min(1, Math.max(base / short, wantEdge / Math.max(region.width, region.height)));
  return Math.min(short, Math.ceil(short * scale));
}

export interface Grid {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  width: number;
  height: number;
}

/**
 * The best of the candidate `[cols, rows]` arrangements: the one whose cells come out largest when the sheet's
 * longest edge is `maxEdge`. `aspect` is a cell's height / width; a cell is never drawn larger than `nativeW`
 * (no upscaling). A multi-piece sheet offers two candidates (pieces across or times across), which is what
 * keeps a row of tall phone frames from shrinking to slivers.
 */
export function chooseGrid(candidates: ReadonlyArray<readonly [number, number]>, aspect: number, maxEdge: number, nativeW: number): Grid {
  let best: Grid | null = null;
  for (const [cols, rows] of candidates) {
    const cellW = Math.max(16, Math.floor(Math.min(nativeW, maxEdge / Math.max(cols, rows * aspect))));
    const cellH = Math.max(1, Math.floor(cellW * aspect));
    const grid = { cols, rows, cellW, cellH, width: cols * cellW, height: rows * cellH };
    // Larger cells win; with equal cells (frames smaller than the cap) the squarer sheet wins over a long strip.
    const squareness = (g: Grid) => Math.max(g.width, g.height) / Math.min(g.width, g.height);
    if (!best || grid.cellW > best.cellW || (grid.cellW === best.cellW && squareness(grid) < squareness(best))) best = grid;
  }
  return best!;
}

/** Every rectangular arrangement of `n` cells that wastes less than one row (what a plain contact sheet picks from). */
export function plainCandidates(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    if ((cols - 1) * rows < n) out.push([cols, rows]);
  }
  return out;
}

/** What to draw in a cell: the picture, or why there is none. */
export interface SheetCell {
  col: number;
  row: number;
  label: string;
  src: Image | Canvas | null;
  /** Said in the cell when there is no picture (a time past the end of that piece). */
  empty?: string;
}

/** `text` cut with an ellipsis until it measures at most `maxW`. */
function fitText(ctx: { measureText: (t: string) => { width: number } }, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** Cells drawn into one JPEG on `grid`: each picture contained in its cell, each labelled top-left. */
export function drawSheetJpeg(cells: SheetCell[], grid: Grid): Promise<Buffer> {
  ensureBundledFontsRegistered();
  const sheet = createCanvas(grid.width, grid.height);
  const ctx = sheet.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, grid.width, grid.height);

  const fontPx = Math.max(10, Math.min(22, Math.round(grid.cellW / 24)));
  const pad = Math.max(3, Math.round(fontPx / 4));
  for (const cell of cells) {
    const x = cell.col * grid.cellW;
    const y = cell.row * grid.cellH;
    if (cell.src) {
      // contain: pieces of another aspect keep their shape, letterboxed in the cell
      const sw = cell.src.width;
      const sh = cell.src.height;
      const k = Math.min(grid.cellW / sw, grid.cellH / sh);
      const dw = sw * k;
      const dh = sh * k;
      ctx.drawImage(cell.src, x + (grid.cellW - dw) / 2, y + (grid.cellH - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = "#1c1c1c";
      ctx.fillRect(x, y, grid.cellW, grid.cellH);
    }
    ctx.font = `600 ${fontPx}px Inter`;
    ctx.textBaseline = "middle";
    const text = fitText(ctx, cell.src ? cell.label : `${cell.label} · ${cell.empty ?? "no frame"}`, grid.cellW - 2 * pad - 8);
    const boxW = ctx.measureText(text).width + 8;
    const boxH = fontPx + 6;
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(x + pad, y + pad, boxW, boxH);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x + pad + 4, y + pad + boxH / 2);
  }
  return sheet.encode("jpeg", SHEET_JPEG_QUALITY);
}

/**
 * `img` cropped to `src` (pixels of `img`), then scaled down so its longest edge is at most `maxEdge`
 * (never up). Null when neither is asked for: the caller keeps the original file.
 */
export function cropAndScale(img: Image, src: Region | null, maxEdge: number | null): Canvas | null {
  const sx = src?.x ?? 0;
  const sy = src?.y ?? 0;
  const sw = src?.width ?? img.width;
  const sh = src?.height ?? img.height;
  const k = maxEdge ? Math.min(1, maxEdge / Math.max(sw, sh)) : 1;
  if (!src && k === 1) return null;
  const w = Math.max(1, Math.round(sw * k));
  const h = Math.max(1, Math.round(sh * k));
  const canvas = createCanvas(w, h);
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return canvas;
}

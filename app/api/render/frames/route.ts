// Next.js-SERVER-ONLY. Rasterizes real composition frames (base scene + overlays)
// to PNG files and runs edge-overflow detection on each. Invoked by the MCP tool
// renderOverlayFrames via HTTP (cross-process pattern: MCP child → Next.js server).
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { ensureBundledFontsRegistered } from "@/lib/fonts/register-server";
import { renderCompositionFrames } from "@/lib/render/frame-capture";
import { detectEdgeOverflow } from "@/lib/render/overflow-detect";
import { loadComposition } from "@/lib/composition/persistence";
import { overlaysActiveAt } from "@/lib/engine/overlays";
import { unresolvedFamilies } from "@/lib/fonts/resolve";
import type { Overlay } from "@/lib/engine/types";
import { serverLogger as logger } from "@/lib/logger";

interface Body {
  pieceId: string;
  atTimes?: number[];
  overlayId?: string;
  source?: "draft" | "snapshot";
  contactSheet?: boolean;
}

/** Contact-sheet layout: a single sheet this wide, however many columns/rows
 *  that implies for the frame count. */
const SHEET_WIDTH_PX = 1600;
const CONTACT_SHEET_JPEG_QUALITY = 85; // @napi-rs/canvas jpeg quality is 0-100, not 0-1.

/**
 * Compose already-rendered frames into ONE labelled JPEG grid — the point is
 * to make looking cheap: one attachment instead of N, one decision instead of
 * N round trips. ceil(sqrt(n)) columns, cells scaled to fit a 1600px-wide
 * sheet (uniform aspect ratio assumed — all cells come from the same
 * composition), each cell labelled with its timestamp so the grid stays
 * readable when the whole point of looking is to check timing.
 */
function buildContactSheetJpeg(cells: { time: number; img: Image }[]): Promise<Buffer> {
  ensureBundledFontsRegistered();
  const n = cells.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const cellWidth = Math.floor(SHEET_WIDTH_PX / cols);
  const aspect = cells[0].img.height / cells[0].img.width;
  const cellHeight = Math.max(1, Math.round(cellWidth * aspect));
  const sheetHeight = cellHeight * rows;

  const sheet = createCanvas(SHEET_WIDTH_PX, sheetHeight);
  const ctx = sheet.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, SHEET_WIDTH_PX, sheetHeight);

  cells.forEach((cell, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellWidth;
    const y = row * cellHeight;
    ctx.drawImage(cell.img, x, y, cellWidth, cellHeight);

    // Timestamp label — an unlabelled grid is unreadable when checking timing.
    const label = `${cell.time.toFixed(2)}s`;
    ctx.font = "600 20px Inter";
    const labelW = ctx.measureText(label).width + 12;
    const labelH = 26;
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(x + 4, y + 4, labelW, labelH);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + 10, y + 4 + labelH / 2);
  });

  return sheet.encode("jpeg", CONTACT_SHEET_JPEG_QUALITY);
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.pieceId) {
    return NextResponse.json({ error: "Missing pieceId" }, { status: 400 });
  }

  // Loaded once, unconditionally: the overlayId convenience path needs it to
  // resolve start/mid/end, and the font-liveness check (below) needs the
  // overlay list regardless of which resolution path was used. Always the
  // DRAFT manifest, even when `source: "snapshot"` renders the frames — the
  // agent is checking the fonts it is currently authoring, not a committed
  // snapshot's frozen ones.
  const { manifest } = await loadComposition(body.pieceId);

  // Resolve timestamps
  let atTimes = body.atTimes?.slice(0, 8);
  if ((!atTimes || atTimes.length === 0) && body.overlayId) {
    const ov = (manifest.overlays ?? []).find((o: { id: string }) => o.id === body.overlayId);
    if (!ov) {
      return NextResponse.json(
        { error: `overlay ${body.overlayId} not found` },
        { status: 404 },
      );
    }
    const start = (ov as { startTime?: number }).startTime ?? 0;
    const dur = (ov as { duration?: number }).duration ?? 0;
    const eps = Math.min(0.05, dur / 10);
    atTimes = [start + eps, start + dur / 2, Math.max(start + eps, start + dur - eps)];
  }

  if (!atTimes || atTimes.length === 0) {
    return NextResponse.json({ error: "Provide atTimes or overlayId" }, { status: 400 });
  }

  try {
    const captured = await renderCompositionFrames(body.pieceId, atTimes, {
      source: body.source,
    });

    const rendered = await Promise.all(
      captured.map(async (f) => {
        // loadImage in @napi-rs/canvas accepts a Buffer (see lib/tracking/verify-render.ts)
        const buf = await fs.readFile(f.path);
        const img = await loadImage(buf);
        ensureBundledFontsRegistered();
        const c = createCanvas(img.width, img.height);
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        const { data } = cx.getImageData(0, 0, img.width, img.height);
        const overflow = detectEdgeOverflow(data, img.width, img.height);
        return { time: f.time, path: f.path, overflow, img };
      }),
    );
    // The per-frame response shape (time/path/overflow) is unchanged; `img`
    // above exists only to build the contact sheet below without re-decoding.
    const frames = rendered.map((r) => ({ time: r.time, path: r.path, overflow: r.overflow }));

    // unresolvedFonts: ALWAYS present (empty when clean) — a field that only
    // sometimes exists is a field an agent forgets to check. Only fonts on
    // text overlays LIVE at one of the requested times count; a family used
    // only outside the rendered window is not actionable noise.
    const overlays = (manifest.overlays ?? []) as Overlay[];
    const liveFonts = new Set<string>();
    for (const t of atTimes) {
      for (const overlay of overlaysActiveAt(overlays, t)) {
        if (overlay.kind === "text") liveFonts.add(overlay.font);
      }
    }
    const unresolvedFonts = unresolvedFamilies(Array.from(liveFonts));

    let contactSheet: string | undefined;
    if (body.contactSheet) {
      const jpeg = await buildContactSheetJpeg(rendered);
      contactSheet = path.join(
        path.dirname(rendered[0].path),
        `contact-sheet-${randomUUID().slice(0, 8)}.jpg`,
      );
      await fs.writeFile(contactSheet, jpeg);
    }

    return NextResponse.json({ frames, unresolvedFonts, ...(contactSheet ? { contactSheet } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { tag: "render-verify", op: "route", pieceId: body.pieceId, err: message },
      "render frames route failed",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

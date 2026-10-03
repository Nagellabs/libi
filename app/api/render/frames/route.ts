// Next.js-SERVER-ONLY. Rasterizes real composition frames (base scene + overlays)
// to PNG files and runs edge-overflow detection on each. Invoked by the MCP tool
// renderOverlayFrames via HTTP (cross-process pattern: MCP child → Next.js server).
//
// One piece → its frames (and, on request, a contact sheet of them). `pieceIds` (2–8) → the SAME times of each
// piece in ONE labelled contact sheet, which is what turns "look at all six" from six renders and six reads
// into one of each. `region` crops each frame to a rectangle of the composition (to read small text) and
// `maxEdge` caps the size of what comes back; the work per piece is `runFramesPass`.
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { FrameTimesOutOfRangeError } from "@/lib/render/frame-capture";
import { RegionOutsideError, runFramesPass, type FramesPass } from "@/lib/render/frames-pass";
import {
  DEFAULT_SHEET_MAX_EDGE,
  chooseGrid,
  drawSheetJpeg,
  plainCandidates,
  type Region,
  type SheetCell,
} from "@/lib/render/frame-sheet";
import { loadComposition } from "@/lib/composition/persistence";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { serverLogger as logger } from "@/lib/logger";

interface Body {
  pieceId?: string;
  pieceIds?: string[];
  atTimes?: number[];
  overlayId?: string;
  source?: "draft" | "snapshot";
  contactSheet?: boolean;
  maxEdge?: number;
  region?: Region;
}

/** Pieces in one multi-piece sheet, and frames in it: past this a cell is too small to judge anything by. */
const MAX_SHEET_PIECES = 8;
const MAX_SHEET_CELLS = 24;

const bad = (error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status: 400 });

const fmtTime = (t: number) => `${Math.round(t * 100) / 100}s`;

function isRegion(r: unknown): r is Region {
  const o = r as Record<string, unknown> | null;
  return (
    !!o &&
    typeof o === "object" &&
    ["x", "y", "width", "height"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k] as number)) &&
    (o.width as number) > 0 &&
    (o.height as number) > 0
  );
}

/** Written next to the first piece's frames; a sheet has no single owner when it spans pieces. */
async function writeSheet(dir: string, jpeg: Buffer): Promise<string> {
  const file = path.join(dir, `contact-sheet-${randomUUID().slice(0, 8)}.jpg`);
  await fs.writeFile(file, jpeg);
  return file;
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.maxEdge !== undefined && !(typeof body.maxEdge === "number" && body.maxEdge >= 64 && body.maxEdge <= 4096)) {
    return bad("maxEdge must be a number from 64 to 4096");
  }
  if (body.region !== undefined && !isRegion(body.region)) {
    return bad("region needs numeric x, y, width, height (composition pixels), width and height above 0");
  }

  if (body.pieceIds && body.pieceIds.length >= 2) return multiPiece(body, body.pieceIds);

  const pieceId = body.pieceId ?? body.pieceIds?.[0];
  if (!pieceId) {
    return NextResponse.json({ error: "Missing pieceId" }, { status: 400 });
  }

  // Loaded once, unconditionally: the overlayId convenience path needs it to
  // resolve start/mid/end, and the font-liveness check (below) needs the
  // overlay list regardless of which resolution path was used. Always the
  // DRAFT manifest, even when `source: "snapshot"` renders the frames — the
  // agent is checking the fonts it is currently authoring, not a committed
  // snapshot's frozen ones.
  const { manifest } = await loadComposition(pieceId);

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
    const pass = await runFramesPass({
      pieceId,
      manifest,
      atTimes,
      source: body.source,
      region: body.region,
      maxEdge: body.maxEdge,
    });

    let contactSheet: string | undefined;
    if (body.contactSheet && pass.cells.length > 0) {
      const first = pass.cells[0].src;
      const grid = chooseGrid(plainCandidates(pass.cells.length), first.height / first.width, body.maxEdge ?? DEFAULT_SHEET_MAX_EDGE, first.width);
      // Each cell labelled with its timestamp — an unlabelled grid is unreadable when the point of looking is to
      // check timing — and with the frame it drew, which is what a diagnostic's `frame` is matched against.
      const cells: SheetCell[] = pass.cells.map((c, i) => ({
        col: i % grid.cols,
        row: Math.floor(i / grid.cols),
        label: `${c.time.toFixed(2)}s · f${c.frame}`,
        src: c.src,
      }));
      contactSheet = await writeSheet(pass.dir, await drawSheetJpeg(cells, grid));
    }

    return NextResponse.json({
      frames: pass.frames,
      unresolvedFonts: pass.unresolvedFonts,
      renderDiagnostics: pass.renderDiagnostics,
      ...(contactSheet ? { contactSheet } : {}),
      ...(pass.region ? { region: pass.region.region, ...(pass.region.clipped ? { regionClipped: true } : {}) } : {}),
    });
  } catch (err) {
    if (err instanceof FrameTimesOutOfRangeError) {
      logger.info(
        { tag: "render-verify", op: "route.past_end", pieceId, times: err.errors.map((e) => e.time) },
        "render frames: times past the end of the piece refused",
      );
      return NextResponse.json(
        { error: err.message, errors: err.errors, duration: err.duration, lastValidTime: err.lastValidTime },
        { status: 400 },
      );
    }
    if (err instanceof RegionOutsideError) return bad(err.message);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { tag: "render-verify", op: "route", pieceId, err: message },
      "render frames route failed",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Several pieces, the same times, one sheet. A piece that cannot be rendered says why and leaves an empty cell. */
async function multiPiece(body: Body, ids: string[]): Promise<Response> {
  const pieceIds = [...new Set(ids)];
  if (pieceIds.length < 2) return bad("pieceIds names the same piece twice: use pieceId");
  if (pieceIds.length > MAX_SHEET_PIECES) return bad(`pieceIds holds ${pieceIds.length} pieces; at most ${MAX_SHEET_PIECES} per sheet`);
  if (body.overlayId && !body.atTimes?.length) return bad("overlayId belongs to one piece: pass atTimes to compare several pieces at the same times");
  const atTimes = body.atTimes?.slice(0, 8);
  if (!atTimes || atTimes.length === 0) return bad("Provide atTimes: the same times are rendered for every piece");
  const timeCount = new Set(atTimes.map((t) => Math.max(0, t))).size;
  if (pieceIds.length * timeCount > MAX_SHEET_CELLS) {
    return bad(`${pieceIds.length} pieces x ${timeCount} times = ${pieceIds.length * timeCount} frames; at most ${MAX_SHEET_CELLS} in one sheet (fewer times, or two calls)`);
  }

  const names = new Map(
    getDb().select({ id: pieces.id, name: pieces.name }).from(pieces).where(inArray(pieces.id, pieceIds)).all().map((r) => [r.id, r.name]),
  );

  type Row = { label: string; pieceId: string; name: string; pass?: FramesPass; error?: string; lastValidTime?: number };
  const rows: Row[] = [];
  // One at a time: each pass drives a Chromium render, and the export scheduler is not asked to run seven at once.
  for (const [i, pieceId] of pieceIds.entries()) {
    const row: Row = { label: `P${i + 1}`, pieceId, name: names.get(pieceId) ?? pieceId };
    try {
      if (!names.has(pieceId)) throw new Error("piece_not_found");
      const { manifest } = await loadComposition(pieceId);
      row.pass = await runFramesPass({ pieceId, manifest, atTimes, source: body.source, region: body.region, maxEdge: body.maxEdge });
    } catch (err) {
      if (err instanceof FrameTimesOutOfRangeError) {
        row.error = err.message;
        row.lastValidTime = err.lastValidTime;
      } else {
        row.error = err instanceof Error ? err.message : String(err);
        if (!(err instanceof RegionOutsideError) && !(err instanceof Error && err.message === "piece_not_found")) {
          logger.error({ tag: "render-verify", op: "route.multi_piece", pieceId, err: row.error }, "render frames: a piece of a multi-piece sheet failed");
        }
      }
    }
    rows.push(row);
  }

  const ok = rows.filter((r) => r.pass && r.pass.cells.length > 0);
  if (ok.length === 0) {
    return bad(`no piece could be rendered: ${rows.map((r) => `${r.name}: ${r.error}`).join("; ")}`, {
      errors: rows.map((r) => ({ pieceId: r.pieceId, error: r.error, ...(r.lastValidTime !== undefined ? { lastValidTime: r.lastValidTime } : {}) })),
    });
  }

  // The sheet: one cell per piece per time. Pieces across or times across, whichever gives the bigger cells
  // (tall phone frames in a row of six would be slivers).
  const sample = ok[0].pass!.cells[0].src;
  const timesShown = Math.max(...ok.map((r) => r.pass!.cells.length));
  const P = rows.length;
  const grid = chooseGrid([[timesShown, P], [P, timesShown]], sample.height / sample.width, body.maxEdge ?? DEFAULT_SHEET_MAX_EDGE, sample.width);
  const piecesAcross = !(grid.cols === timesShown && grid.rows === P);
  const cells: SheetCell[] = [];
  rows.forEach((row, i) => {
    const wanted = row.pass?.cells ?? [];
    const slots = row.pass ? wanted.length : timesShown;
    for (let j = 0; j < slots; j++) {
      const c = wanted[j];
      cells.push({
        col: piecesAcross ? i : j,
        row: piecesAcross ? j : i,
        label: c ? `${row.label} ${fmtTime(c.time)} ${row.name}` : `${row.label} ${row.name}`,
        src: c ? c.src : null,
        empty: row.error ? (row.lastValidTime !== undefined ? "past the end" : "not rendered") : undefined,
      });
    }
  });
  const contactSheet = await writeSheet(ok[0].pass!.dir, await drawSheetJpeg(cells, grid));

  const failures = rows.filter((r) => r.error);
  return NextResponse.json({
    pieces: rows.map((r) => ({
      label: r.label,
      pieceId: r.pieceId,
      name: r.name,
      ...(r.error ? { error: r.error, ...(r.lastValidTime !== undefined ? { lastValidTime: r.lastValidTime } : {}) } : {}),
    })),
    // No overflow here: with six pieces it is six times the noise, and a sheet is read by looking.
    frames: rows.flatMap((r) =>
      (r.pass?.frames ?? []).map((f) => ({ piece: r.label, time: f.time, frame: f.frame, path: f.path, ...(f.blank ? { blank: true as const } : {}) })),
    ),
    unresolvedFonts: [...new Set(rows.flatMap((r) => r.pass?.unresolvedFonts ?? []))],
    renderDiagnostics: rows.flatMap((r) => (r.pass?.renderDiagnostics ?? []).map((d) => ({ ...d, pieceId: r.pieceId, piece: r.label }))),
    contactSheet,
    ...(failures.length > 0 ? { failed: failures.length } : {}),
  });
}

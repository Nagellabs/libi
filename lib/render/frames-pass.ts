// Next.js-SERVER-ONLY. One piece's pass of `libi.render_overlay_frames`: render the asked frames, then read
// what the pixels say about them (edge overflow, blank), crop / cap them when asked, and collect the body
// failures and unresolved fonts of exactly the frames drawn. The route composes passes into a response;
// several pieces are several passes and one sheet.
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createCanvas, loadImage, type Canvas, type Image } from "@napi-rs/canvas";
import { ensureBundledFontsRegistered } from "@/lib/fonts/register-server";
import { renderCompositionFrames } from "@/lib/render/frame-capture";
import { detectEdgeOverflow } from "@/lib/render/overflow-detect";
import { isBlankFrame } from "@/lib/render/blank-detect";
import { renderDiagnosticsFor } from "@/lib/render/frame-diagnostics";
import { clampRegion, cropAndScale, regionShortSide, type Region } from "@/lib/render/frame-sheet";
import type { RenderDiagnosticRecord } from "@/lib/render/render-diagnostics-types";
import type { CompositionManifest, PersistedOverlay } from "@/lib/composition/persistence";
import { overlaysActiveAt } from "@/lib/engine/overlays";
import { unresolvedFamilies } from "@/lib/fonts/resolve";
import type { Overlay } from "@/lib/engine/types";
import { serverLogger as logger } from "@/lib/logger";

export class RegionOutsideError extends Error {
  constructor(compW: number, compH: number) {
    super(`region lies outside the composition (${compW}x${compH}): give x, y, width, height in composition pixels`);
    this.name = "RegionOutsideError";
  }
}

export interface FrameEntry {
  time: number;
  frame: number;
  /** The frame as the agent should open it: the original PNG, or the cropped / capped copy when one was asked for. */
  path: string;
  overflow: { touchesEdge: boolean; edges: string[] };
  /** Present (true) only when the frame (the region, when one was asked for) is effectively one flat colour. */
  blank?: true;
}

export interface FramesPass {
  frames: FrameEntry[];
  /** What a contact sheet draws for each frame: the cropped picture when there is one, else the render. */
  cells: { time: number; frame: number; src: Image | Canvas }[];
  unresolvedFonts: string[];
  renderDiagnostics: RenderDiagnosticRecord[];
  /** The region actually used (cut to the composition), when one was asked for. */
  region?: { region: Region; clipped: boolean };
  /** Directory the frame files were written to. */
  dir: string;
}

export interface FramesPassOptions {
  pieceId: string;
  /** The piece's DRAFT manifest: the fonts checked are the ones being authored even when a snapshot is rendered. */
  manifest: CompositionManifest;
  atTimes: number[];
  source?: "draft" | "snapshot";
  region?: Region;
  /** Cap on a returned file's longest edge; only applied when the caller set it. */
  maxEdge?: number;
}

export async function runFramesPass(opts: FramesPassOptions): Promise<FramesPass> {
  const { pieceId, manifest, atTimes, source } = opts;

  let region: FramesPass["region"];
  if (opts.region) {
    const clamped = clampRegion(opts.region, manifest.width, manifest.height);
    if (!clamped) throw new RegionOutsideError(manifest.width, manifest.height);
    region = clamped;
  }

  const captured = await renderCompositionFrames(pieceId, atTimes, {
    source,
    // A region is read at its own scale: render big enough that its text has pixels (the full frame is ~720 short side).
    ...(region ? { maxShortSide: regionShortSide(region.region, manifest.width, manifest.height) } : {}),
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
      const full = cx.getImageData(0, 0, img.width, img.height);
      // Overflow is about the composition's edges, so it is read on the whole frame even when a region was cropped.
      const overflow = detectEdgeOverflow(full.data, img.width, img.height);

      // The render's pixels per composition pixel (the frame is rendered smaller than the composition).
      const kx = img.width / manifest.width;
      const ky = img.height / manifest.height;
      const src: Region | null = region
        ? {
            x: Math.round(region.region.x * kx),
            y: Math.round(region.region.y * ky),
            width: Math.max(1, Math.round(region.region.width * kx)),
            height: Math.max(1, Math.round(region.region.height * ky)),
          }
        : null;
      const view = cropAndScale(img, src, opts.maxEdge ?? null);
      let outPath = f.path;
      let blank: boolean;
      if (view) {
        outPath = path.join(path.dirname(f.path), `${path.basename(f.path, ".png")}-view.png`);
        await fs.writeFile(outPath, await view.encode("png"));
        const px = view.getContext("2d").getImageData(0, 0, view.width, view.height);
        blank = isBlankFrame(px.data, view.width, view.height);
      } else {
        blank = isBlankFrame(full.data, img.width, img.height);
      }
      return { time: f.time, frame: f.frame, path: outPath, overflow, blank, src: (view ?? img) as Image | Canvas };
    }),
  );

  // Per frame: the time asked for, the absolute `frame` drawn for it (so a diagnostic's frame can be matched, and
  // a time that lands on a neighbouring frame is visible), the PNG and its overflow. `blank: true` only when the
  // frame is effectively one flat colour: a body that threw draws nothing and the frame still looks "rendered".
  const frames: FrameEntry[] = rendered.map((r) => ({
    time: r.time,
    frame: r.frame,
    path: r.path,
    overflow: r.overflow,
    ...(r.blank ? { blank: true as const } : {}),
  }));

  // unresolvedFonts: ALWAYS present (empty when clean) — a field that only sometimes exists is a field an agent
  // forgets to check. Only fonts on text overlays LIVE on a frame that was drawn count — at that frame's own time,
  // not the time asked for (4.99 s draws the frame at 4.967 s, and the text on it is what must resolve); a family
  // used only outside the rendered frames is not actionable noise.
  const overlays = (manifest.overlays ?? []) as Overlay[];
  const liveFonts = new Set<string>();
  for (const { frameTime } of captured) {
    for (const overlay of overlaysActiveAt(overlays, frameTime)) {
      if (overlay.kind === "text") liveFonts.add(overlay.font);
    }
  }
  const unresolvedFonts = unresolvedFamilies(Array.from(liveFonts));

  // Body failures of THIS pass (the render page posted them before the render resolved), for the overlays and
  // frames drawn. ALWAYS present, like unresolvedFonts. A snapshot render files nothing against the draft, so
  // there is nothing to report for it.
  const renderDiagnostics =
    source === "snapshot"
      ? []
      : await renderDiagnosticsFor(
          pieceId,
          (manifest.overlays ?? []) as PersistedOverlay[],
          captured.map((c) => ({ frame: c.frame, frameTime: c.frameTime })),
        ).catch((err) => {
          logger.warn(
            { tag: "render-verify", op: "diagnostics_read_failed", pieceId, err: err instanceof Error ? err.message : String(err) },
            "render frames: could not read the body diagnostics",
          );
          return [] as RenderDiagnosticRecord[];
        });

  return {
    frames,
    cells: rendered.map((r) => ({ time: r.time, frame: r.frame, src: r.src })),
    unresolvedFonts,
    renderDiagnostics,
    ...(region ? { region } : {}),
    dir: captured.length > 0 ? path.dirname(captured[0].path) : "",
  };
}

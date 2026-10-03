// Next.js-SERVER-ONLY (reads the studio's in-memory diagnostics store).
//
// What `libi.render_overlay_frames` reports about the bodies it just drew. The
// render page posts its report to the store before the render resolves
// (`/api/export/render-result`), so by the time the route has its PNGs the
// failures of THIS pass are in `getRenderDiagnostics` — merged with whatever
// the open preview saw. This keeps the entries that are about the frames the
// agent asked for.
import type { Overlay } from "@/lib/engine/types";
import { overlaysActiveAt } from "@/lib/engine/overlays";
import type { PersistedOverlay } from "@/lib/composition/persistence";
import { overlayCodeFilePath } from "@/lib/overlays/code-files";
import { bodyHashesOf } from "./body-hashes";
import {
  getRenderDiagnostics,
  type RenderDiagnostic,
  type RenderDiagnosticRecord,
} from "./render-diagnostics-store";

export interface RenderedFrame {
  /** The absolute composition frame drawn. */
  frame: number;
  /** That frame's own composition second. */
  frameTime: number;
}

/**
 * The diagnostics that describe the rendered frames: a body that failed to
 * compile or build is shown while it is on screen at any rendered frame (it
 * drew nothing there); a render error only for a frame this pass drew (an
 * entry with no frame — an async escape, a timeout — names none, so it is
 * kept while its overlay is on screen).
 */
export function diagnosticsForFrames(
  diagnostics: readonly RenderDiagnostic[],
  overlays: readonly Overlay[],
  frames: readonly RenderedFrame[],
): RenderDiagnostic[] {
  const live = new Set<string>();
  for (const f of frames) for (const o of overlaysActiveAt(overlays as Overlay[], f.frameTime)) live.add(o.id);
  const drawn = new Set(frames.map((f) => f.frame));
  return diagnostics.filter((d) => {
    if (!live.has(d.overlayId)) return false;
    if (d.phase !== "render") return true;
    return d.frame === undefined || drawn.has(d.frame);
  });
}

/** The body failures of the frames just rendered, each with the code file to fix. */
export async function renderDiagnosticsFor(
  pieceId: string,
  overlays: readonly PersistedOverlay[],
  frames: readonly RenderedFrame[],
): Promise<RenderDiagnosticRecord[]> {
  const hashes = await bodyHashesOf(overlays);
  const mine = diagnosticsForFrames(getRenderDiagnostics(pieceId, (id) => hashes.get(id)), overlays as Overlay[], frames);
  const byId = new Map(overlays.map((o) => [o.id, o]));
  return Promise.all(
    mine.map(async (d) => {
      const overlay = byId.get(d.overlayId);
      const file = overlay ? await overlayCodeFilePath(pieceId, overlay).catch(() => undefined) : undefined;
      return file ? { ...d, file } : { ...d };
    }),
  );
}

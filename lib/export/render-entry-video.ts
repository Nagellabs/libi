// lib/export/render-entry-video.ts
//
// The canvas export's video sources, split out of the browser-only render entry
// (`render-entry.ts`) so the fallback and the drop reporting are testable without
// mediabunny — the same seam as render-entry-three / render-entry-quads.

import type { Overlay } from "@/lib/engine/types";

/** What `MediaBunnyExportFrameSource` offers this loader. */
export interface LoadableVideoSource {
  whenReady(): Promise<unknown>;
  dispose(): void;
}

export interface VideoSourceDeps<S extends LoadableVideoSource> {
  createSource: (url: string) => S;
  /** Browser console on the render page; injectable for tests. */
  warn: (message: string, detail: Record<string, unknown>) => void;
}

/** One overlay the render page went out without, as it posts it back. The export runner turns
 *  these into `lib/export/dropped-overlays.ts#DroppedOverlay` (kind, file, name, cause). */
export type RenderDroppedOverlay = { id: string; message: string };

/** How a clip that could not be loaded at all is reported — the export runner reads this prefix
 *  to tell a clip missing from the whole export from one that failed on some frames. */
export const VIDEO_LOAD_FAILURE_MESSAGE =
  "its video could not be loaded for export (neither the original file nor its proxy)";

const originalUrl = (fileId: string) => `/api/files/by-id/${fileId}/content`;
const proxyUrl = (fileId: string) => `/api/files/by-id/${fileId}/proxy`;

/**
 * One source per plain or tracked video overlay, keyed by overlay id to match
 * `renderFrame` / `drawOverlay`.
 *
 * Always tries the ORIGINAL file (`/content`) first — exports read originals,
 * not the proxy (mediabunny/WebCodecs decodes the original directly). If the
 * original is undecodable by WebCodecs, the proxy is used, so the export still
 * produces frames (lower res, but frame-exact).
 *
 * A video neither loads is DROPPED: the export goes on without it, and it is
 * listed in `dropped` with the reason, for the export result's `droppedOverlays`
 * — never left out silently, which exported a video with a missing clip as a
 * success. Each abandoned source is disposed at once so its fetch and demuxer
 * are not held until GC.
 */
export async function loadVideoSourcesWithDeps<S extends LoadableVideoSource>(
  overlays: Overlay[],
  deps: VideoSourceDeps<S>,
): Promise<{ sources: Record<string, S>; dropped: RenderDroppedOverlay[] }> {
  const entries: Array<{ id: string; fileId: string }> = [];
  for (const o of overlays) {
    if (o.kind === "video") entries.push({ id: o.id, fileId: o.fileId });
    else if (o.kind === "tracked" && o.content.kind === "video") entries.push({ id: o.id, fileId: o.content.fileId });
  }

  const sources: Record<string, S> = {};
  const dropped: RenderDroppedOverlay[] = [];
  await Promise.all(
    entries.map(async ({ id, fileId }) => {
      let src: S | null = null;
      try {
        src = deps.createSource(originalUrl(fileId));
        await src.whenReady();
        sources[id] = src;
        return;
      } catch (err) {
        src?.dispose();
        deps.warn("[Render] original decode init failed; trying proxy", { id, fileId, error: (err as Error).message });
      }
      let proxySrc: S | null = null;
      try {
        proxySrc = deps.createSource(proxyUrl(fileId));
        await proxySrc.whenReady();
        sources[id] = proxySrc;
      } catch (err) {
        proxySrc?.dispose();
        const reason = (err as Error).message;
        deps.warn("[Render] video source load failed (original + proxy)", { id, fileId, error: reason });
        dropped.push({
          id,
          message: `${VIDEO_LOAD_FAILURE_MESSAGE}${reason ? `: ${reason}` : ""}`,
        });
      }
    }),
  );
  return { sources, dropped };
}

/** The render's own drops, plus the ones found before it started; one entry per overlay, the
 *  render's first. */
export function mergeDroppedOverlays(
  rendered: RenderDroppedOverlay[] | undefined,
  loadFailures: RenderDroppedOverlay[],
): RenderDroppedOverlay[] {
  const out = [...(rendered ?? [])];
  const seen = new Set(out.map((d) => d.id));
  for (const d of loadFailures) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

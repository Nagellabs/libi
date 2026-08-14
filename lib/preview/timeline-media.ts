/**
 * Pure helpers for painting real media inside timeline bars + scene blocks.
 *
 * NO React, NO DOM. The Timeline collects the distinct VIDEO fileIds (so it can
 * make ONE `useFilmstripStatuses` call), then resolves each bar/block to a CSS
 * background paint:
 *   - image overlay → its `/content` image (no sprite, no hook)
 *   - video overlay / video scene → its filmstrip sprite when ready, else null
 *     (the bar keeps its solid fallback while the lazy ensure generates one)
 */
import type { Composition } from "@/lib/engine/types";
import { filmstripBackgroundStyle } from "@/lib/filmstrip/geometry";
import { filmstripUrl, type FilmstripStatus } from "@/lib/queries/filmstrips";

export interface MediaRef {
  kind: "image" | "video";
  fileId: string;
}

/**
 * Map overlayId / sceneId → its media reference, collected from the
 * composition's image/video overlays and video scenes. Canvas scenes, text /
 * code / three / tracked overlays have no paintable media and are omitted.
 */
export function buildMediaById(
  composition: Composition | null,
): Map<string, MediaRef> {
  const map = new Map<string, MediaRef>();
  if (!composition) return map;

  for (const o of composition.overlays ?? []) {
    if (o.kind === "image" && o.fileId) {
      map.set(o.id, { kind: "image", fileId: o.fileId });
    } else if (o.kind === "video" && o.fileId) {
      map.set(o.id, { kind: "video", fileId: o.fileId });
    }
  }


  return map;
}

/** The distinct VIDEO fileIds in a media map — what the Timeline feeds to
 *  `useFilmstripStatuses` (image bars don't need a status). */
export function distinctVideoFileIds(mediaById: Map<string, MediaRef>): string[] {
  const ids = new Set<string>();
  for (const ref of mediaById.values()) {
    if (ref.kind === "video") ids.add(ref.fileId);
  }
  return Array.from(ids);
}

/** The CSS background style for painting a bar/block. `null` = no media to
 *  paint (keep the solid fallback). */
export interface MediaPaint {
  backgroundImage: string;
  backgroundSize: string;
  backgroundRepeat: string;
  backgroundPosition: string;
}

export interface ResolvePaintArgs {
  ref: MediaRef | undefined;
  /** Filmstrip status for the ref's fileId (video only). */
  status?: FilmstripStatus;
  /** Rendered bar width in px (zoom-aware). */
  barWidthPx: number;
}

/**
 * Resolve the CSS background paint for one bar/block:
 *   - image → its content image at `cover` (always paintable)
 *   - video + filmstrip ready → the sprite via `filmstripBackgroundStyle`
 *   - video + filmstrip not ready → null (solid fallback; lazy ensure runs)
 */
export function resolveMediaPaint(args: ResolvePaintArgs): MediaPaint | null {
  const { ref, status, barWidthPx } = args;
  if (!ref) return null;

  if (ref.kind === "image") {
    return {
      backgroundImage: `url(/api/files/by-id/${ref.fileId}/content)`,
      backgroundSize: "cover",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "center",
    };
  }

  // video
  if (status?.status === "ready") {
    const geo = filmstripBackgroundStyle({
      barWidthPx,
      frames: status.frames ?? 0,
      frameHeightPx: status.height ?? 0,
    });
    return {
      backgroundImage: `url(${filmstripUrl(ref.fileId)})`,
      backgroundSize: geo.backgroundSize,
      backgroundRepeat: geo.backgroundRepeat,
      backgroundPosition: "left center",
    };
  }

  return null;
}

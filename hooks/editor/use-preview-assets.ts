"use client";

import type { Composition, DrawContext } from "@/lib/engine/types";
import type {
  VideoFrameSource,
  VideoFrameSourceError,
} from "@/lib/engine/video-frame-source";
import type { ThreeOverlayInstance } from "@/lib/engine/three-overlay";
import type { OverlayQuadInstance } from "@/lib/engine/overlay-quad";
import type { ContentBox } from "@/lib/overlays/code-content-fit";
import type { FrameStore, SeekSignalStore } from "@/lib/preview/frame-store";
import { useVideoSources } from "@/hooks/preview/use-video-sources";
import { useOverlayImages } from "@/hooks/preview/use-overlay-images";
import { useOverlayCompiledFns } from "@/hooks/preview/use-overlay-code";
import { useOverlayThreeScenes } from "@/hooks/preview/use-overlay-three";
import { useOverlayQuads } from "@/hooks/preview/use-overlay-quads";
import { useOverlayFonts } from "@/hooks/preview/use-overlay-fonts";

export interface PreviewAssets {
  videoSources: Record<string, VideoFrameSource>;
  videoErrors: Record<string, VideoFrameSourceError>;
  images: Record<string, HTMLImageElement>;
  compiledDrawFns: Record<string, (ctx: DrawContext) => void>;
  /** overlayId → probed code-overlay content ink-bbox (drives the contain-fit). */
  codeContentBoxes: Record<string, ContentBox | null>;
  threeScenes: Record<string, ThreeOverlayInstance>;
  spatialQuads: Record<string, OverlayQuadInstance>;
  /** overlayId → compile/build-error message for code + three overlays whose
   *  current source failed to compile (drives the overlay error badge). */
  overlayErrors: Record<string, string>;
  /** Bumps when an uploaded custom font finishes loading — threaded into
   *  `<PreviewPlayer>` so a paused preview repaints with the now-available
   *  family. */
  fontsVersion: number;
}

/**
 * Bundles the three preview-asset hooks (video frame sources, overlay
 * image elements, compiled code-overlay draw fns) into one call. Each
 * underlying hook manages its own cache + lifecycle; this is a thin
 * convenience wrapper so the editor page doesn't have to thread three
 * separate variables through to `<PreviewPlayer>`.
 *
 * `playing` + `speed` + `frame` are forwarded to `useVideoSources` (which
 * drives play/pause, `<video>.playbackRate`, and the boundary-preroll
 * controller on the hidden elements). The image + code caches depend solely
 * on the composition shape.
 */
export function usePreviewAssets(
  composition: Composition | null,
  playing: boolean,
  speed: number = 1,
  /** Playhead frame store — forwarded to `useVideoSources`, which subscribes to
   *  it imperatively so the source budget runs at 30 Hz WITHOUT re-rendering the
   *  host (preview-surface) per frame. */
  frameStore: FrameStore,
  /** Discrete user-seek signal — forwarded to `useVideoSources` so a scrub/jump
   *  hard-seeks all sources (flush stale warm/ahead frames). */
  seekSignal?: SeekSignalStore,
): PreviewAssets {
  const { sources: videoSources, errors: videoErrors } = useVideoSources(
    composition,
    playing,
    speed,
    frameStore,
    seekSignal,
  );
  const { images } = useOverlayImages(composition);
  const { compiledDrawFns, codeContentBoxes, errors: codeErrors } = useOverlayCompiledFns(composition);
  const { threeScenes, errors: threeErrors } = useOverlayThreeScenes(composition);
  const { spatialQuads } = useOverlayQuads(composition);
  // Registers uploaded fonts via the FontFace API so text overlays paint
  // their custom family. The returned version bump triggers a repaint once a
  // newly-registered font finishes loading.
  const { version: fontsVersion } = useOverlayFonts(composition);
  const overlayErrors = { ...(codeErrors ?? {}), ...(threeErrors ?? {}) };
  return { videoSources, videoErrors, images, compiledDrawFns, codeContentBoxes, threeScenes, spatialQuads, overlayErrors, fontsVersion };
}

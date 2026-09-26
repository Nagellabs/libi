"use client";

import type { Composition } from "@/lib/engine/types";
import type {
  VideoFrameSource,
  VideoFrameSourceError,
} from "@/lib/engine/video-frame-source";
import type { ThreeOverlayInstance } from "@/lib/engine/three-overlay";
import type { OverlayQuadInstance } from "@/lib/engine/overlay-quad";
import type { FrameStore, SeekSignalStore } from "@/lib/preview/frame-store";
import type { PreviewLayerSource } from "@/lib/sandbox/preview-layers";
import type {
  RenderDiagnosticInput,
  UnattributedDiagnosticInput,
} from "@/hooks/preview/use-overlay-layers";
import { useVideoSources } from "@/hooks/preview/use-video-sources";
import { useOverlayImages } from "@/hooks/preview/use-overlay-images";
import { useOverlayLayers } from "@/hooks/preview/use-overlay-layers";
import { useOverlayThreeScenes } from "@/hooks/preview/use-overlay-three";
import { useOverlayQuads } from "@/hooks/preview/use-overlay-quads";
import { useOverlayFonts } from "@/hooks/preview/use-overlay-fonts";

export interface PreviewAssets {
  videoSources: Record<string, VideoFrameSource>;
  videoErrors: Record<string, VideoFrameSourceError>;
  images: Record<string, HTMLImageElement>;
  /** Sandboxed body layers (code / three / tracked-code) — spec §4.5. */
  layers: PreviewLayerSource | null;
  /** Body overlays whose source the sandbox has loaded cleanly at least once. */
  loadedBodies: ReadonlySet<string>;
  /** 3D-TEXT instances only; `three` bodies render through `layers`. */
  threeScenes: Record<string, ThreeOverlayInstance>;
  spatialQuads: Record<string, OverlayQuadInstance>;
  /** overlayId → compile/build/render/timeout message for body overlays and
   *  build-error message for 3D text (drives the overlay error badge). */
  overlayErrors: Record<string, string>;
  /** Bumps when an uploaded custom font finishes loading — threaded into
   *  `<PreviewPlayer>` so a paused preview repaints with the now-available
   *  family. */
  fontsVersion: number;
}

export interface PreviewAssetsOptions {
  onDiagnostic?: (d: RenderDiagnosticInput) => void;
  onDiagnosticCleared?: (overlayId: string) => void;
  onUnattributed?: (d: UnattributedDiagnosticInput) => void;
  onUnattributedCleared?: (message: string) => void;
  /** Which store the callbacks file under (the piece): a change re-announces
   *  every failure still on screen to the new one. */
  diagnosticsKey?: string;
}

/**
 * Bundles the preview-asset hooks (video frame sources, overlay image
 * elements, sandboxed body layers, 3D-text instances, spatial quads, fonts)
 * into one call. Each underlying hook manages its own cache + lifecycle; this
 * is a thin convenience wrapper so the editor page doesn't have to thread
 * each one separately through to `<PreviewPlayer>`.
 *
 * `playing` + `speed` + `frameStore` are forwarded to `useVideoSources` (which
 * drives play/pause, `<video>.playbackRate`, and the boundary-preroll
 * controller on the hidden elements). The rest depend on the composition shape.
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
  options: PreviewAssetsOptions = {},
): PreviewAssets {
  const { sources: videoSources, errors: videoErrors } = useVideoSources(
    composition,
    playing,
    speed,
    frameStore,
    seekSignal,
  );
  const { images } = useOverlayImages(composition);
  const { layers, errors: layerErrors, loadedBodies } = useOverlayLayers(composition, {
    images,
    onDiagnostic: options.onDiagnostic,
    onDiagnosticCleared: options.onDiagnosticCleared,
    onUnattributed: options.onUnattributed,
    onUnattributedCleared: options.onUnattributedCleared,
    diagnosticsKey: options.diagnosticsKey,
  });
  const { threeScenes, errors: threeErrors } = useOverlayThreeScenes(composition);
  const { spatialQuads } = useOverlayQuads(composition);
  // Registers uploaded fonts via the FontFace API so text overlays paint
  // their custom family. The returned version bump triggers a repaint once a
  // newly-registered font finishes loading.
  const { version: fontsVersion } = useOverlayFonts(composition);
  const overlayErrors = { ...layerErrors, ...threeErrors };
  return { videoSources, videoErrors, images, layers, loadedBodies, threeScenes, spatialQuads, overlayErrors, fontsVersion };
}

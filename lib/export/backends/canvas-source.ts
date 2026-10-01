"use client";

import { exportVideo } from "@/lib/engine/export";
import type { ExportBackend, ExportContext } from "../backend";
import type { ExportResult } from "@/lib/engine/types";
import { BROWSER_CANVAS_EXPORT_FLAG, compHasAudibleAudio } from "../classifier";

/**
 * Browser-only backend. Wraps the existing exportVideo() which relies on
 * OffscreenCanvas + WebCodecs. Invoked by the client-side exportRouter
 * when `classifyExportShape` returns "canvas-source" — NEVER imported by
 * the server route (/api/export/ffmpeg), because this module imports
 * browser-only globals indirectly via lib/engine/export.ts.
 *
 * It encodes VIDEO ONLY — exportVideo() writes no audio track. The classifier
 * never routes a composition with sound here, and if one arrives anyway
 * (the flag forced, a caller bypassing the classifier) it is refused rather
 * than exported silent. Muxing audio here is a feature, not a fix.
 */
export class CanvasSourceBackend implements ExportBackend {
  name = "canvas-source" as const;
  async run(ctx: ExportContext): Promise<ExportResult> {
    if (compHasAudibleAudio(ctx.composition)) {
      throw new Error(
        `This export path can't include audio; turn off ${BROWSER_CANVAS_EXPORT_FLAG} or remove the audio.`,
      );
    }
    // No fs write — this backend exists in the browser. The returned blob
    // is what the UI handles (triggers the download).
    return exportVideo(
      ctx.composition,
      ctx.settings,
      ctx.onProgress,
      ctx.videoFrameSources,
    );
  }
}

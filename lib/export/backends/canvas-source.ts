"use client";

import { exportVideo } from "@/lib/engine/export";
import type { ExportBackend, ExportContext } from "../backend";
import type { ExportResult } from "@/lib/engine/types";

/**
 * Browser-only backend. Wraps the existing exportVideo() which relies on
 * OffscreenCanvas + WebCodecs. Invoked by the client-side exportRouter
 * when `classifyExportShape` returns "canvas-source" — NEVER imported by
 * the server route (/api/export/ffmpeg), because this module imports
 * browser-only globals indirectly via lib/engine/export.ts.
 */
export class CanvasSourceBackend implements ExportBackend {
  name = "canvas-source" as const;
  async run(ctx: ExportContext): Promise<ExportResult> {
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

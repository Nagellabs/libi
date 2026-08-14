import type { Composition, ExportResult, ExportSettings } from "@/lib/engine/types";
import type { VideoFrameSource } from "@/lib/engine/video-frame-source";
import type { RenderPayload } from "@/lib/export/render-jobs";

export interface ExportContext {
  composition: Composition;
  settings: ExportSettings;
  /** Provided by the BROWSER path (canvas-source backend) — the client has live
   *  VideoFrameSource instances. Server backends don't use this field. */
  videoFrameSources?: Record<string, VideoFrameSource>;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
  /** Absolute filesystem path for server backends. Browser backend ignores this. */
  outputPath?: string;
  /** Piece ID — required by the chromium-render backend; other backends don't use it. */
  pieceId?: string;
  /** Raw render payload — the chromium-render backend sends this to the render
   *  page for client-side hydration via buildComposition(). Other backends
   *  don't use this field. Compiled draw functions can't cross JSON boundaries,
   *  so the payload carries raw scene data + files instead of a hydrated Composition. */
  payload?: RenderPayload;
}

export interface ExportBackend {
  name: "stream-copy-trim" | "ffmpeg-overlay" | "canvas-source" | "chromium-render";
  /** Runs the export. Browser backends return only a Blob (no outputPath).
   *  Server backends write to outputPath AND return a Blob of the bytes. */
  run(ctx: ExportContext): Promise<ExportResult>;
}

"use client";

import type { Composition, ExportResult, ExportSettings } from "@/lib/engine/types";
import type { VideoFrameSource } from "@/lib/engine/video-frame-source";
import { stripHiddenLayers } from "@/lib/overlays/hidden";
import { classifyExportShape } from "./classifier";
import { CanvasSourceBackend } from "./backends/canvas-source";

export interface RouterOptions {
  composition: Composition;
  settings: ExportSettings;
  videoFrameSources?: Record<string, VideoFrameSource>;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
  /** Required when the router dispatches to the server route — the server
   *  loads composition + files from DB by pieceId. */
  pieceId: string;
  /**
   * Which state to export from.
   * - "draft"    (default) — reads composition.json (the working copy)
   * - "snapshot" — reads snapshots/current.json (the last committed state)
   * Server backends re-load the manifest by pieceId; this param tells them
   * which file to read. The canvas-source backend uses the `composition`
   * prop already hydrated by the caller, which must match this value.
   */
  source?: "draft" | "snapshot";
}

async function postServerBackend(
  shape: "stream-copy-trim" | "ffmpeg-overlay",
  opts: RouterOptions,
): Promise<ExportResult> {
  const body = {
    pieceId: opts.pieceId,
    compositionId: opts.composition.id,
    shape,
    settings: opts.settings,
    source: opts.source ?? "draft",
  };
  const res = await fetch("/api/export/ffmpeg", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`Export failed: ${res.status} ${await res.text()}`);
  }
  const blob = await res.blob();
  const durationHeader = res.headers.get("X-Export-Duration-Seconds");
  return {
    blob,
    duration: durationHeader ? parseFloat(durationHeader) : 0,
    format: opts.settings.format,
  };
}

export async function exportRouter(
  opts: RouterOptions,
): Promise<ExportResult & { backend: string }> {
  // Hidden layers (overlay.hidden — the persisted eye toggle) leave the export
  // entirely: strip them + their coupled inline audio FIRST, so classification
  // and the in-browser canvas backend describe the same filtered composition
  // the server routes derive from the manifest.
  const composition = stripHiddenLayers(opts.composition);
  if (composition !== opts.composition) opts = { ...opts, composition };

  const shape = classifyExportShape(composition);

  if (shape.tag === "error") {
    if (shape.reason === "nothing to export") {
      throw new Error("Nothing to export — add a video, text, or other layer first.");
    }
    throw new Error(`Cannot export: ${shape.reason}`);
  }

  if (shape.tag === "canvas-source") {
    const backend = new CanvasSourceBackend();
    const result = await backend.run(opts);
    return { ...result, backend: "canvas-source" };
  }

  if (shape.tag === "chromium-render") {
    const res = await fetch("/api/export/chromium", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pieceId: opts.pieceId,
        settings: opts.settings,
        source: opts.source ?? "draft",
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`Chromium export failed (${res.status}): ${await res.text()}`);
    }
    const blob = await res.blob();
    const backendHeader = res.headers.get("X-Export-Backend") ?? "chromium-render";
    const durationHeader = res.headers.get("X-Export-Duration-Seconds");
    return {
      blob,
      duration: durationHeader ? parseFloat(durationHeader) : 0,
      format: opts.settings.format,
      backend: backendHeader,
    };
  }

  // Server backends — POST to /api/export/ffmpeg.
  const result = await postServerBackend(shape.tag, opts);
  return { ...result, backend: shape.tag };
}

/**
 * Browser-only render entry for the off-browser canvas export flow.
 *
 * Loaded by `/render` (served as a static HTML Route Handler) inside a
 * hidden Playwright/Electron page. This module is bundled by esbuild
 * via `/api/export/render-bundle` so it runs without Next.js's client
 * runtime — Next 16 dev mode (turbopack) does not hydrate reliably in
 * Playwright Chromium, which is why we bypass React entirely here.
 *
 * Registers itself as `window.__libiRender` so the inline bootstrap
 * script in the `/render` HTML can trigger `runRender()`.
 */
import { exportVideo } from "@/lib/engine/export";
import { getCompositionFrames } from "@/lib/engine/renderer";
import { buildComposition } from "@/lib/composition/build-composition";
import type { SceneData } from "@/lib/composition/build-composition";
import type {
  AudioClip,
  Composition,
  DrawContext,
  ExportSettings,
  Overlay,
} from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";
import { createDrawFunction } from "@/lib/ai/scene-validator";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import { measureOverlayContentBoxes } from "@/lib/overlays/code-content-fit";
import type { VideoFrameSource } from "@/lib/engine/video-frame-source";
import { MediaBunnyExportFrameSource } from "@/lib/engine/media-bunny-export-frame-source";
import { hydrateCustomEffects } from "@/lib/effects/hydrate-custom-client";
import { buildOverlayThreeScenesWithDeps } from "@/lib/export/render-entry-three";
import { buildOverlaySpatialQuadsWithDeps } from "@/lib/export/render-entry-quads";
import { loadOverlayTracks } from "@/lib/export/render-overlay-tracks";

interface JobPayload {
  scenes: SceneData[];
  overlays: Overlay[];
  audioClips: AudioClip[];
  width: number;
  height: number;
  fps: number;
  files: FileRecord[];
  totalFrames?: number;
  frameRange?: { startFrame: number; endFrameExclusive: number };
}

interface JobResponse {
  jobId: string;
  pieceId: string;
  payload: JobPayload;
  settings: ExportSettings;
}

function setStatus(text: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

/**
 * Best-effort: POST per-frame progress to the server so the JobManager can
 * surface a live percent to the UI / MCP clients. Errors are swallowed so a
 * flaky network hop never aborts the render.
 */
async function reportProgress(
  jobId: string,
  token: string,
  done: number,
  total: number,
): Promise<void> {
  try {
    await fetch(`/api/export/render-progress/${jobId}/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done, total }),
    });
  } catch {
    // Best-effort — render continues if the progress post fails.
  }
}

/**
 * Load an HTMLImageElement and await its `onload`. Resolves to `null` on
 * error so callers can no-op rather than failing the whole export.
 */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => {
      console.warn("[Render] image load failed", url);
      resolve(null);
    };
    img.src = url;
  });
}

/** Build the per-overlay image map (image + tracked-image overlays). */
async function loadOverlayImages(
  overlays: Overlay[],
  filesMap: Map<string, FileRecord>,
): Promise<Record<string, HTMLImageElement>> {
  const tasks: Array<Promise<[string, HTMLImageElement | null]>> = [];
  for (const o of overlays) {
    let fileId: string | null = null;
    if (o.kind === "image") fileId = o.fileId;
    else if (o.kind === "tracked" && o.content.kind === "image")
      fileId = o.content.fileId;
    if (!fileId) continue;
    if (!filesMap.has(fileId)) {
      console.warn("[Render] overlay references missing file", { overlayId: o.id, fileId });
      continue;
    }
    const url = `/api/files/by-id/${fileId}/content`;
    tasks.push(loadImage(url).then((img) => [o.id, img] as [string, HTMLImageElement | null]));
  }
  const results = await Promise.all(tasks);
  const out: Record<string, HTMLImageElement> = {};
  for (const [id, img] of results) {
    if (img) out[id] = img;
  }
  return out;
}

/** Compile code + tracked-code overlay draw functions. */
function compileOverlayDrawFns(
  overlays: Overlay[],
): Record<string, (ctx: DrawContext) => void> {
  const out: Record<string, (ctx: DrawContext) => void> = {};
  for (const o of overlays) {
    let source: string | null = null;
    if (o.kind === "code") source = o.drawFunction;
    else if (o.kind === "tracked" && o.content.kind === "code")
      source = o.content.drawFunction;
    if (!source) continue;
    try {
      out[o.id] = createDrawFunction(source, DRAW_HELPERS) as unknown as (
        ctx: DrawContext,
      ) => void;
    } catch (err) {
      console.warn("[Render] failed to compile overlay draw fn", {
        overlayId: o.id,
        error: (err as Error).message,
      });
    }
  }
  return out;
}

/** Build a ThreeOverlayInstance per `three` overlay AND per `text+threeD`
 *  overlay for the export pass — keyed by `overlay.id` into one scenes map,
 *  mirroring the preview hook (`useOverlayThreeScenes`). Without the `text+threeD`
 *  half, 3D text exports flat because the renderer's `case "text"` finds no
 *  instance and falls back to `drawTextOverlay`.
 *
 *  Awaits each instance's text-rasterization readiness so the FIRST captured
 *  frame is deterministic (no blank text). One shared renderer for the whole
 *  export. Decision + build logic + DI lives in `render-entry-three.ts` (pure +
 *  unit-tested); this wires the real browser implementations (font fetch via
 *  /fonts/3d/<file> for bundled, /api/files/by-id/<id>/content for uploaded —
 *  both valid in the headless-Chromium render page). */
async function buildOverlayThreeScenes(overlays: Overlay[]): Promise<{
  scenes: Record<string, import("@/lib/engine/three-overlay").ThreeOverlayInstance>;
  dispose: () => void;
}> {
  const [
    { createSharedThreeRenderer, buildThreeInstance },
    { buildTextThreeInstance },
    { makeBrowserTextThreeDeps },
  ] = await Promise.all([
    import("@/lib/engine/three-overlay"),
    import("@/lib/engine/text-3d/build-text-three"),
    import("@/lib/engine/text-3d/browser-deps"),
  ]);
  return buildOverlayThreeScenesWithDeps(overlays, {
    createSharedThreeRenderer,
    buildThreeInstance,
    buildTextThreeInstance,
    makeBrowserTextThreeDeps,
  });
}

/** Build one `OverlayQuadInstance` per perspective-tilted image/video/code/
 *  flat-text overlay (the preview's `useOverlayQuads` parity for the export
 *  pass), so a spatially-transformed 2D overlay renders in the export instead of
 *  vanishing. Wires the real browser three-overlay + overlay-quad impls. */
async function buildOverlaySpatialQuads(overlays: Overlay[]): Promise<{
  quads: Record<string, import("@/lib/engine/overlay-quad").OverlayQuadInstance>;
  dispose: () => void;
}> {
  const [{ createSharedThreeRenderer }, { buildQuadInstance }] = await Promise.all([
    import("@/lib/engine/three-overlay"),
    import("@/lib/engine/overlay-quad"),
  ]);
  return buildOverlaySpatialQuadsWithDeps(overlays, {
    createSharedThreeRenderer,
    buildQuadInstance,
  });
}

/**
 * Build one `MediaBunnyExportFrameSource` per video scene + plain/tracked video
 * overlay, keyed by scene.id / overlay.id to match `renderFrame` / `drawOverlay`.
 *
 * Always resolves the ORIGINAL file (`/content`) — exports read originals, not
 * the 720p proxy (mediabunny/WebCodecs decodes the original directly). If the
 * original is undecodable by WebCodecs, fall back to the proxy URL so the export
 * still produces frames (lower res, but frame-exact).
 */
async function loadVideoSources(
  composition: Composition,
  filesMap: Map<string, FileRecord>,
): Promise<Record<string, VideoFrameSource>> {
  const entries: Array<{ id: string; fileId: string; fallbackUrl: string | null }> = [];

  void filesMap;
  for (const o of composition.overlays ?? []) {
    if (o.kind === "video") {
      entries.push({ id: o.id, fileId: o.fileId, fallbackUrl: null });
    } else if (o.kind === "tracked" && o.content.kind === "video") {
      entries.push({ id: o.id, fileId: o.content.fileId, fallbackUrl: null });
    }
  }

  const originalUrl = (fileId: string) => `/api/files/by-id/${fileId}/content`;
  const proxyUrl = (fileId: string) => `/api/files/by-id/${fileId}/proxy`;

  const map: Record<string, VideoFrameSource> = {};
  await Promise.all(
    entries.map(async ({ id, fileId, fallbackUrl }) => {
      // 1) original — dispose the abandoned source on failure so its mediabunny
      //    Input (network fetch + demuxer) isn't held until GC before we retry.
      let src: MediaBunnyExportFrameSource | null = null;
      try {
        src = new MediaBunnyExportFrameSource(originalUrl(fileId));
        await src.whenReady();
        map[id] = src;
        return;
      } catch (err) {
        src?.dispose();
        console.warn("[Render] original decode init failed; trying proxy", {
          id, fileId, error: (err as Error).message,
        });
      }
      // 2) proxy (explicit proxy route, or the scene's pickVideoUrl fallback)
      const fb = fallbackUrl ?? proxyUrl(fileId);
      let proxySrc: MediaBunnyExportFrameSource | null = null;
      try {
        proxySrc = new MediaBunnyExportFrameSource(fb);
        await proxySrc.whenReady();
        map[id] = proxySrc;
      } catch (err) {
        proxySrc?.dispose();
        console.warn("[Render] video source load failed (original + proxy)", {
          id, fileId, fb, error: (err as Error).message,
        });
      }
    }),
  );
  return map;
}

export async function runRender({
  jobId,
  token,
}: {
  jobId: string;
  token: string;
}): Promise<void> {
  console.log("[Render] runRender start", { jobId });
  try {
    setStatus("fetching-job");
    console.log("[Render] fetching job");
    const res = await fetch(`/api/export/render-job/${jobId}`, {
      headers: { "x-render-token": token },
    });
    if (!res.ok) throw new Error(`Job fetch failed: ${res.status}`);
    const { payload, settings } = (await res.json()) as JobResponse;
    console.log("[Render] job fetched", {
      scenes: payload.scenes?.length,
      files: payload.files?.length,
      overlays: payload.overlays?.length,
    });

    setStatus("hydrating");
    // Register custom effect packages into THIS bundle's registry before any
    // frame is rendered — the render entry is a standalone esbuild bundle with
    // its own module instances, so the server's boot-time registration doesn't
    // reach it. Best-effort: built-in effects render regardless.
    const customCount = await hydrateCustomEffects();
    console.log("[Render] custom effects registered", { customCount });
    const filesMap = new Map<string, FileRecord>(
      payload.files.map((f) => [f.id, f]),
    );
    const base = buildComposition(payload.scenes, filesMap, payload.overlays, payload.audioClips);
    if (!base) throw new Error("Composition is empty (no scenes)");
    const composition: Composition = {
      ...base,
      width: payload.width,
      height: payload.height,
      fps: payload.fps,
    };

    // Build the per-overlay asset maps the unified renderer needs. All loaders
    // are individually robust — a missing image/track/video/code source logs a
    // warning and skips that overlay/scene rather than failing the export.
    setStatus("loading-overlays");
    const overlays = composition.overlays ?? [];
    const [imageElements, tracks, videoFrameSources] = await Promise.all([
      loadOverlayImages(overlays, filesMap),
      loadOverlayTracks(overlays),
      loadVideoSources(composition, filesMap),
    ]);
    const compiledDrawFns = compileOverlayDrawFns(overlays);
    // Probe each code overlay's drawn-ink bbox once so the renderer contain-fits
    // the content into its rect (same as the preview hook does). Runs in the
    // headless Chromium render page → real OffscreenCanvas is available.
    const codeContentBoxes = measureOverlayContentBoxes(overlays, compiledDrawFns);
    const three = await buildOverlayThreeScenes(overlays);
    const quads = await buildOverlaySpatialQuads(overlays);

    console.log("[Render] overlay assets loaded", {
      images: Object.keys(imageElements).length,
      tracks: Object.keys(tracks).length,
      videoSources: Object.keys(videoFrameSources).length,
      compiledFns: Object.keys(compiledDrawFns).length,
    });

    setStatus("rendering");
    // When rendering a chunk, progress + the stall-watchdog frame counts are
    // CHUNK-LOCAL (each chunk is its own registry job). Absent frameRange →
    // the whole composition, exactly as before.
    const frameRange = payload.frameRange;
    const compositionFrames = getCompositionFrames(composition);
    const chunkFrames = frameRange
      ? frameRange.endFrameExclusive - frameRange.startFrame
      : compositionFrames;
    console.log("[Render] hydrated; starting exportVideo", {
      sceneCount: composition.scenes.length,
      compositionFrames,
      frameRange,
      chunkFrames,
      duration: composition.scenes.reduce(
        (acc, s) => acc + (s.duration ?? 0),
        0,
      ),
    });
    const start = performance.now();
    let lastReportedFrame = -1;
    const result = await exportVideo(
      composition,
      settings,
      (progress) => {
        const framesDone = Math.round(progress * chunkFrames);
        // Report every ~30 frames or on the final frame.
        const isLast = framesDone >= chunkFrames;
        if (isLast || framesDone - lastReportedFrame >= 30) {
          lastReportedFrame = framesDone;
          void reportProgress(jobId, token, framesDone, chunkFrames);
        }
      },
      videoFrameSources,
      imageElements,
      compiledDrawFns,
      tracks,
      three.scenes,
      quads.quads,
      codeContentBoxes,
      frameRange,
    );
    const elapsedSeconds = (performance.now() - start) / 1000;
    console.log("[Render] exportVideo done", {
      size: result.blob.size,
      // Wall-clock encode time (diagnostics only) vs the reported VIDEO length.
      elapsedSeconds,
      videoDurationSeconds: result.duration,
    });
    // Encoding is finished with the decoders — release them now. The render
    // window is torn down per-job anyway, but disposing promptly frees the
    // mediabunny Input + WebCodecs decoder for each source without waiting on GC.
    for (const s of Object.values(videoFrameSources)) s.dispose();
    three.dispose(); // free 3D-overlay geometries/materials/text + the shared WebGL context
    quads.dispose(); // free spatial-quad geometries/materials/textures + their shared WebGL context

    setStatus("uploading");
    const fd = new FormData();
    fd.append("jobId", jobId);
    fd.append("token", token);
    // Report the VIDEO length (rendered range length = totalFrames/fps,
    // chunk-local when this is one chunk of a chunked render), NOT the wall-clock
    // encode time — this flows to ExportResult.duration → the
    // X-Export-Duration-Seconds header and the audio-mux progress hint, both of
    // which mean "output duration". The chunked path already posts totalFrames/fps;
    // this unifies the single-chunk path to the same semantics.
    fd.append("durationSeconds", String(result.duration));
    fd.append("file", result.blob, `out.${settings.format}`);
    const up = await fetch("/api/export/render-result", {
      method: "POST",
      body: fd,
    });
    if (!up.ok) throw new Error(`Result upload failed: ${up.status}`);

    setStatus("done");
    console.log("[Render] done");
  } catch (err) {
    const message = (err as Error).message;
    console.error("[Render] caught error:", err);
    setStatus(`error: ${message}`);
    await fetch("/api/export/render-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId, token, message }),
    }).catch(() => {});
  }
}

// Register on window so the bootstrap script in /render HTML can call it.
// (Can't use an ES-module export consumer because the bootstrap script is
// inline and needs a predictable global hook.)
declare global {
  interface Window {
    __libiRender?: { runRender: typeof runRender };
  }
}
window.__libiRender = { runRender };

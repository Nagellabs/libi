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
import { ensureBundledFontsLoaded } from "@/lib/fonts/load-client";
import { loadOverlayFonts } from "@/lib/fonts/registry-client";
import { getCompositionFrames } from "@/lib/engine/renderer";
import { buildComposition } from "@/lib/composition/build-composition";
import type {
  AudioClip,
  Composition,
  ExportSettings,
  Overlay,
} from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";
import type { VideoFrameSource } from "@/lib/engine/video-frame-source";
import { MediaBunnyExportFrameSource } from "@/lib/engine/media-bunny-export-frame-source";
import { hydrateCustomEffects } from "@/lib/effects/hydrate-custom-client";
import { configureEffectSampler, prepareCustomEffectCurves } from "@/lib/effects/custom-curves";
import { resolveEffect } from "@/lib/effects/registry";
import { EffectSampler } from "@/lib/sandbox/effect-sampler";
import { buildOverlayThreeScenesWithDeps } from "@/lib/export/render-entry-three";
import { buildOverlaySpatialQuadsWithDeps } from "@/lib/export/render-entry-quads";
import { loadVideoSourcesWithDeps, mergeDroppedOverlays } from "@/lib/export/render-entry-video";
import { loadOverlayTracks } from "@/lib/export/render-overlay-tracks";
import { OverlaySandbox, type LoadInput } from "@/lib/sandbox/host";
import { createIframeTransport } from "@/lib/sandbox/iframe-transport";
import { EXPORT_SANDBOX_OPTIONS, ExportLayerSource, buildExportDiagnosticsReport } from "@/lib/sandbox/export-layers";
import { collectSandboxFonts } from "@/lib/sandbox/fonts";
import { collectSandboxImages } from "@/lib/sandbox/images";
import { sha256Hex } from "@/lib/sandbox/hash";
import type { BodyKind } from "@/lib/sandbox/protocol";
import { getOverlayBody } from "@/lib/overlays/code-fields";
import type { PersistedOverlay } from "@/lib/composition/persistence";

interface JobPayload {
  overlays: Overlay[];
  audioClips: AudioClip[];
  width: number;
  height: number;
  fps: number;
  files: FileRecord[];
  totalFrames?: number;
  frameRange?: { startFrame: number; endFrameExclusive: number };
  /** The verify render's explicit frames (`RenderPayload.frames`). */
  frames?: number[];
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

/** Longest the render page waits for the sandbox to take every body. A body
 *  that will not load (a compile error, a build that hangs) costs that
 *  overlay, not the export: past this the export runs and each unloaded body
 *  is a dropped overlay. A sandbox that never came up AT ALL is different —
 *  every body overlay would be missing, so the export fails, loudly, rather
 *  than listing them all as "did not load" (final security review, I3). */
const BODY_LOAD_BUDGET_MS = 20_000;
export const SANDBOX_NEVER_CAME_UP_MESSAGE = `the overlay sandbox did not come up within ${BODY_LOAD_BUDGET_MS / 1000} s, so every code, three and tracked-code overlay would be missing from this export`;

function bodyKindOf(o: Overlay): BodyKind | null {
  if (o.kind === "code") return "code";
  if (o.kind === "three") return "three";
  if (o.kind === "tracked" && o.content.kind === "code") return "tracked";
  return null;
}

interface OverlayLayers {
  layers: ExportLayerSource;
  /** Kind and source hash per body overlay — what the diagnostics name. */
  bodies: Map<string, { kind: BodyKind; sourceHash: string }>;
  loaded: number;
  dispose(): void;
}

/**
 * Bring up the overlay sandbox for this render (spec §4.6) — the SAME
 * sandboxed runtime the preview uses: an opaque-origin iframe whose worker
 * runs every code / three / tracked-code body. No body executes in this
 * page's origin. Loads every body once, and returns the frame-exact
 * LayerSource the export loop settles before each frame.
 */
async function buildOverlayLayers(
  overlays: Overlay[],
  imageElements: Record<string, HTMLImageElement>,
): Promise<OverlayLayers> {
  const inputs: LoadInput[] = [];
  const bodies = new Map<string, { kind: BodyKind; sourceHash: string }>();
  for (const o of overlays) {
    const kind = bodyKindOf(o);
    if (!kind) continue;
    const source = getOverlayBody(o as unknown as PersistedOverlay) ?? "";
    const sourceHash = await sha256Hex(source);
    bodies.set(o.id, { kind, sourceHash });
    inputs.push({
      id: o.id,
      kind,
      source,
      sourceHash,
      // The protocol requires a positive load size (each render carries the
      // real per-frame one).
      width: Math.max(1, o.rect?.width || 1),
      height: Math.max(1, o.rect?.height || 1),
      ...(o.kind === "three" ? { three: { cameraPreset: o.cameraPreset ?? "billboard", pixelRatio: 1 as const } } : {}),
    });
  }
  if (inputs.length === 0) {
    return { layers: new ExportLayerSource(() => -1), bodies, loaded: 0, dispose() {} };
  }

  let source: ExportLayerSource | null = null;
  const sandbox = new OverlaySandbox({
    // A dead frame fails the export; it is never replaced mid-run (R2-M1). So
    // does a live frame whose worker is not back in time after a restart (R3-M3).
    ...EXPORT_SANDBOX_OPTIONS,
    // Always the sandbox: the dev-only in-origin mode is preview-only
    // (lib/sandbox/mode.ts), so an export always crosses the real boundary.
    createTransport: (nonce) => createIframeTransport(document.body, nonce),
    onLayer: (m) => (source ? source.onLayer(m) : m.bitmap.close()),
    onError: (m) => source?.onError(m),
    onUnattributed: (m) => source?.onUnattributed(m),
    onTimeout: (id, phase, afterMs, reason) => source?.onTimeout(id, phase, afterMs, reason),
    onRestart: () => source?.onRestart(),
    onFrameLost: (message) => source?.onFrameLost(message),
  });
  // Re-issuing a cached input after a restart joins the host's own replay of
  // it (one post each) and is how the export learns the body is back.
  const loadAll = () => Promise.all(inputs.map((i) => sandbox.load(i).catch(() => {}))).then(() => {});
  source = new ExportLayerSource((input) => sandbox.render(input), { reloadAll: loadAll });

  // Piece images, as bitmaps, only for bodies that can reach them (loadImage).
  const images = inputs.some((i) => i.source.includes("loadImage"))
    ? await collectSandboxImages(overlays, imageElements)
    : {};
  for (const input of inputs) if (input.source.includes("loadImage")) input.images = images;
  sandbox.setFonts(await collectSandboxFonts(overlays));

  // A compile/build failure is recorded through onError and reported as a
  // dropped overlay; it never fails the export.
  let budget: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    loadAll(),
    new Promise<void>((resolve) => {
      budget = setTimeout(() => {
        console.warn("[Render] overlay sandbox did not take every body in time", { budgetMs: BODY_LOAD_BUDGET_MS });
        resolve();
      }, BODY_LOAD_BUDGET_MS);
    }),
  ]);
  clearTimeout(budget);
  if (sandbox.isFrameLost() || sandbox.generation() === 0) {
    sandbox.destroy();
    for (const b of Object.values(images)) b.close();
    throw new Error(sandbox.isFrameLost() ? sandbox.frameLostMessage : SANDBOX_NEVER_CAME_UP_MESSAGE);
  }
  const layers = source;
  let disposed = false;
  return {
    layers,
    bodies,
    loaded: inputs.filter((i) => sandbox.isLoaded(i.id)).length,
    dispose() {
      if (disposed) return;
      disposed = true;
      layers.dispose();
      sandbox.destroy();
      for (const b of Object.values(images)) b.close();
    },
  };
}

/** Build a ThreeOverlayInstance per 3D-TEXT overlay (`text+threeD` or
 *  place3d) for the export pass — keyed by `overlay.id`, mirroring the preview
 *  hook (`useOverlayThreeScenes`). Without it 3D text exports flat because the
 *  renderer's `case "text"` finds no instance and falls back to
 *  `drawTextOverlay`. `three` BODIES are not built here: they render in the
 *  overlay sandbox (`buildOverlayLayers`).
 *
 *  Awaits each instance's text-rasterization readiness so the FIRST captured
 *  frame is deterministic (no blank text). One shared renderer for the whole
 *  export. Decision + build logic + DI lives in `render-entry-three.ts` (pure +
 *  unit-tested); this wires the real browser implementations (font fetch via
 *  /fonts/3d/<file> for bundled, /api/files/by-id/<id>/content for uploaded —
 *  both valid in the headless-Chromium render page). */
async function buildOverlayThreeScenes(overlays: Overlay[]): Promise<{
  scenes: Record<string, import("@/lib/engine/three-renderer").ThreeOverlayInstance>;
  dispose: () => void;
}> {
  const [
    { createSharedThreeRenderer },
    { buildTextThreeInstance },
    { makeBrowserTextThreeDeps },
  ] = await Promise.all([
    import("@/lib/engine/three-renderer"),
    import("@/lib/engine/text-3d/build-text-three"),
    import("@/lib/engine/text-3d/browser-deps"),
  ]);
  return buildOverlayThreeScenesWithDeps(overlays, {
    createSharedThreeRenderer,
    buildTextThreeInstance,
    makeBrowserTextThreeDeps,
  });
}

/** Build one `OverlayQuadInstance` per perspective-tilted image/video/code/
 *  flat-text overlay (the preview's `useOverlayQuads` parity for the export
 *  pass), so a spatially-transformed 2D overlay renders in the export instead of
 *  vanishing. Wires the real browser three-renderer + overlay-quad impls. */
async function buildOverlaySpatialQuads(overlays: Overlay[]): Promise<{
  quads: Record<string, import("@/lib/engine/overlay-quad").OverlayQuadInstance>;
  dispose: () => void;
}> {
  const [{ createSharedThreeRenderer }, { buildQuadInstance }] = await Promise.all([
    import("@/lib/engine/three-renderer"),
    import("@/lib/engine/overlay-quad"),
  ]);
  return buildOverlaySpatialQuadsWithDeps(overlays, {
    createSharedThreeRenderer,
    buildQuadInstance,
  });
}

export async function runRender({
  jobId,
  token,
}: {
  jobId: string;
  token: string;
}): Promise<void> {
  console.log("[Render] runRender start", { jobId });
  // Disposed on every exit, not only the happy path (T10 minor): a render
  // that throws mid-export must still tear down the sandbox frame.
  let bodyLayers: OverlayLayers | null = null;
  try {
    setStatus("fetching-job");
    console.log("[Render] fetching job");
    const res = await fetch(`/api/export/render-job/${jobId}`, {
      headers: { "x-render-token": token },
    });
    if (!res.ok) throw new Error(`Job fetch failed: ${res.status}`);
    const { payload, settings } = (await res.json()) as JobResponse;
    console.log("[Render] job fetched", {
      files: payload.files?.length,
      overlays: payload.overlays?.length,
    });

    setStatus("hydrating");
    // Download the bundled text faces BEFORE the first frame is captured.
    // The render page declares them via @font-face (app/render/route.ts), but
    // an @font-face is lazy and a canvas draw never triggers the fetch — so
    // without this the opening frames bake in a fallback face at the wrong
    // width. See lib/fonts/load-client.ts for the measured proof.
    await ensureBundledFontsLoaded();
    console.log("[Render] bundled fonts loaded");
    // Uploaded fonts (libi.upload_font → overlay.fontFileId), registered the
    // way the preview does and awaited before the first frame. Without this
    // they exported in the default face (QA 2026-09-18 recheck N5). Failures
    // go back with the result so the server logs them.
    const unloadedFonts = await loadOverlayFonts(payload.overlays ?? []);
    if (unloadedFonts.length) console.warn("[Render] uploaded fonts failed to load", { unloadedFonts });
    // Register custom effect packages into THIS bundle's registry before any
    // frame is rendered — the render entry is a standalone esbuild bundle with
    // its own module instances, so the server's boot-time registration doesn't
    // reach it. Best-effort: built-in effects render regardless. Their
    // `animate.js` never runs on this page: the effect sandbox samples it
    // (always the real sandbox here, like the overlay bodies).
    configureEffectSampler(() => new EffectSampler({ createTransport: (nonce) => createIframeTransport(document.body, nonce) }));
    const customCount = await hydrateCustomEffects();
    console.log("[Render] custom effects registered", { customCount });
    const filesMap = new Map<string, FileRecord>(
      payload.files.map((f) => [f.id, f]),
    );
    // The export's own dims go INTO the build: legacy text normalization
    // derives its wrap width from them (QA 2026-09-18 recheck N4).
    const composition: Composition = buildComposition(filesMap, payload.overlays, payload.audioClips, {
      width: payload.width,
      height: payload.height,
      fps: payload.fps,
    });
    if (!composition) throw new Error("Composition is empty");

    // Build the per-overlay asset maps the unified renderer needs. All loaders
    // are individually robust — a missing image/track/video/code source logs a
    // warning and skips that overlay/scene rather than failing the export.
    setStatus("loading-overlays");
    const overlays = composition.overlays ?? [];
    const [imageElements, tracks, videoLoad] = await Promise.all([
      loadOverlayImages(overlays, filesMap),
      loadOverlayTracks(overlays),
      loadVideoSourcesWithDeps(overlays, {
        createSource: (url) => new MediaBunnyExportFrameSource(url),
        warn: (message, detail) => console.warn(message, detail),
      }),
    ]);
    const videoFrameSources: Record<string, VideoFrameSource> = videoLoad.sources;
    // Every custom-effect slot's curve is sampled BEFORE the first frame; one
    // that cannot be sampled fails the export, naming the effect, rather than
    // exporting it without its animation.
    const customCurves = await prepareCustomEffectCurves(overlays, resolveEffect);
    console.log("[Render] custom effect curves sampled", { customCurves });
    const three = await buildOverlayThreeScenes(overlays);
    const quads = await buildOverlaySpatialQuads(overlays);
    bodyLayers = await buildOverlayLayers(overlays, imageElements);

    console.log("[Render] overlay assets loaded", {
      images: Object.keys(imageElements).length,
      tracks: Object.keys(tracks).length,
      videoSources: Object.keys(videoFrameSources).length,
      bodies: bodyLayers.bodies.size,
      bodiesLoaded: bodyLayers.loaded,
    });

    setStatus("rendering");
    // When rendering a chunk, progress + the stall-watchdog frame counts are
    // CHUNK-LOCAL (each chunk is its own registry job). Absent frameRange →
    // the whole composition, exactly as before.
    // A verify render (`libi.render_overlay_frames`) names its frames instead,
    // and renders only those.
    const frameRange = payload.frameRange ?? (payload.frames ? { frames: payload.frames } : undefined);
    const compositionFrames = getCompositionFrames(composition);
    const chunkFrames = !frameRange
      ? compositionFrames
      : "frames" in frameRange
        ? frameRange.frames.length
        : frameRange.endFrameExclusive - frameRange.startFrame;
    console.log("[Render] hydrated; starting exportVideo", {
      overlayCount: composition.overlays?.length ?? 0,
      compositionFrames,
      frameRange,
      chunkFrames,
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
      bodyLayers.bodies.size ? bodyLayers.layers : undefined,
      tracks,
      three.scenes,
      quads.quads,
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
    // What the bodies did, for libi.get_piece_state (spec §4.7) — read before
    // the sandbox goes; then tear its frame down with the page's other GPU
    // resources (spec §4.9).
    const diagnosticsReport = bodyLayers.bodies.size
      ? buildExportDiagnosticsReport(bodyLayers.layers, bodyLayers.bodies, { fps: composition.fps, now: Date.now() })
      : null;
    bodyLayers.dispose();

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
    // Overlays skipped this render because their draw threw (QA 2026-09-18
    // B1) — forwarded to the server so it can log it loud and surface it in
    // the export result, instead of only the info-level console line above.
    // Plus the videos that could not be loaded at all (original and proxy both failed), which the
    // render drew without — reported the same way rather than exported silently without the clip.
    const droppedOverlays = mergeDroppedOverlays(result.droppedOverlays, videoLoad.dropped);
    if (droppedOverlays.length) {
      fd.append("droppedOverlays", JSON.stringify(droppedOverlays));
    }
    if (unloadedFonts.length) fd.append("unloadedFonts", JSON.stringify(unloadedFonts));
    // Body failures, unattributed runtime diagnostics and the frames each body
    // rendered cleanly: the server merges them into the piece's diagnostics
    // (and retires ones this render proved fixed).
    if (diagnosticsReport) fd.append("renderDiagnostics", JSON.stringify(diagnosticsReport));
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
  } finally {
    bodyLayers?.dispose();
    configureEffectSampler(null);
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

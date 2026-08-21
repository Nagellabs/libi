// Next.js-SERVER-ONLY. Drives the Chromium render backend + ffmpeg. NEVER import
// this from any file under mcp/ (use the HTTP route instead). Read-only w.r.t.
// the composition — it renders, it does not mutate.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { ChromiumRenderBackend } from "@/lib/export/backends/chromium-render";
import { loadComposition } from "@/lib/composition/persistence";
import type { CompositionManifest } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import type { AudioClip, Composition, ExportSettings, Overlay } from "@/lib/engine/types";
import { getDb } from "@/lib/db/client";
import { files as filesTable } from "@/lib/db/schema";
import type { RenderPayload } from "@/lib/export/render-jobs";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { getLibiStorageDir } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";

export interface CapturedFrame {
  time: number;  // requested timestamp (seconds)
  path: string;  // absolute path to the written PNG
}

export interface RenderFramesOptions {
  source?: "draft" | "snapshot";  // default "draft"
  outDir?: string;                // default <storage>/<pieceId>/_verify
  maxShortSide?: number;          // cap the SHORTER frame dimension for speed; default 720
  signal?: AbortSignal;
}

/**
 * Pure helper — compute even render dims capping the SHORTER side (no upscale).
 * Capping the shorter side keeps the pixel budget equal across orientations
 * (a 16:9 and a 9:16 source both render at ~maxShortSide × (16/9·maxShortSide)).
 */
export function computeVerifyDims(
  srcW: number,
  srcH: number,
  maxShortSide: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxShortSide / Math.min(srcW, srcH));
  const even = (n: number) => { const r = Math.round(n); return r - (r % 2); };
  return { width: Math.max(2, even(srcW * scale)), height: Math.max(2, even(srcH * scale)) };
}

/**
 * Hydrate a stub `Composition` from persisted manifest + scenes purely for the
 * classifier. The classifier only inspects discriminant fields (scene.type,
 * overlays[], audioClips[]) so we don't need real draw callables or video URLs.
 *
 * Mirrors the private `buildCompositionFromManifest` in
 * `app/api/export/chromium/route.ts` — a small justified duplication so this
 * module stays server-importable independently of the API route tree.
 */
function buildCompositionFromManifest(
  manifest: CompositionManifest,
): Composition {
  return {
    id: "composition-1",
    name: "Export",
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps,
    overlays: (manifest.overlays ?? []) as Overlay[],
    audioClips: (manifest.audioClips ?? []) as AudioClip[],
  };
}

/**
 * Every file id an overlay mounts — the overlay's own `fileId` and the one on a
 * tracked overlay's mounted image/video content, which is a second nesting
 * level a `.map(o => o.fileId)` silently misses.
 *
 * Exported for the test that pins the payload contract: the render page can
 * only hydrate source dimensions for files it was actually handed.
 */
export function overlayFileIds(overlays: readonly Overlay[]): string[] {
  const ids = new Set<string>();
  for (const o of overlays) {
    const own = (o as { fileId?: unknown }).fileId;
    if (typeof own === "string") ids.add(own);
    const content = (o as { content?: { fileId?: unknown } }).content;
    if (content && typeof content.fileId === "string") ids.add(content.fileId);
  }
  return [...ids];
}

/** Bitrate for the verify-only chromium render. The MP4 is a transient
 *  vehicle for single-frame extraction (agent vision checks) — 2 Mbps at the
 *  ≤720 short-side verify resolution is fully legible and keeps the render
 *  postback small and fast. Real exports set their own ExportSettings. */
export const VERIFY_BITRATE_BPS = 2_000_000;

export async function renderCompositionFrames(
  pieceId: string,
  atTimes: number[],
  opts: RenderFramesOptions = {},
): Promise<CapturedFrame[]> {
  if (atTimes.length === 0) {
    throw new Error("renderCompositionFrames: atTimes must be non-empty");
  }

  // Clamp/round each time to >= 0, dedup, sort
  const times = Array.from(new Set(atTimes.map((t) => Math.max(0, t)))).sort(
    (a, b) => a - b,
  );

  const startAt = Date.now();
  logger.info(
    { tag: "render-verify", op: "render_frames", pieceId, times, source: opts.source ?? "draft" },
    "render-verify: start",
  );

  // Load manifest + scenes
  let manifest: CompositionManifest;

  if (opts.source === "snapshot") {
    const snap = await loadCurrentSnapshot(pieceId);
    if (!snap) {
      throw new Error(`renderCompositionFrames: no committed snapshot found for piece ${pieceId}`);
    }
    manifest = snap;
  } else {
    ({ manifest } = await loadComposition(pieceId));
  }

  // Build the stub Composition (used only by classifier / ExportContext contract)
  const stub = buildCompositionFromManifest(manifest);

  // Build RenderPayload.
  //
  // WHAT THIS PATH OWES A TRACKED OVERLAY. Its samples are in SOURCE-VIDEO
  // pixels, and `resolveTrackedSpace` (lib/engine/tracked-space.ts) needs the
  // owning video's `sourceWidth`/`sourceHeight` to map them into composition
  // space. Without them it falls back to "the source fills the rect", which
  // puts the reticle somewhere it isn't. This module is what backs
  // `libi.render_overlay_frames` — the tool the skills tell agents to use to
  // LOOK at their own work — so a frame that lies here sends an agent off
  // "fixing" code that was already right.
  //
  // THOSE DIMS COME FROM `files`, NOT FROM `overlays`. Wrapping the overlays in
  // `attachOverlaySourceDims`, the way the chromium route does, achieves
  // nothing here and it takes a measurement to see why: the render page
  // hydrates with `buildComposition(payload.scenes, filesMap, payload.overlays,
  // …)` (lib/export/render-entry.ts), which rebuilds every video overlay as
  // `{ …o, sourceWidth: file?.mediaWidth ?? null }` — UNCONDITIONALLY. Anything
  // attached upstream is overwritten, with `null` whenever the file is missing
  // from `payload.files`. So the files list is the only seam that reaches the
  // renderer, and an overlay-side attach is dead code that reads as a
  // safeguard. (The route's own second call, on the composition it classifies,
  // is a different thing and is load-bearing there.)
  //
  // Which is why the query is not piece-scoped alone. `files.piece_id` is
  // nullable — the shared asset library — and a video overlay may mount a
  // global file. Sending only the piece's rows hands the render page a clip
  // with no dims and no source to decode: an empty panel, and any tracked art
  // riding on it placed against a rect-fill guess.
  const overlays = (manifest.overlays ?? []) as Overlay[];
  const pieceFiles = getDb()
    .select()
    .from(filesTable)
    .where(eq(filesTable.pieceId, pieceId))
    .all();
  const missingIds = new Set(overlayFileIds(overlays));
  for (const f of pieceFiles) missingIds.delete(f.id);
  const globalFiles =
    missingIds.size > 0
      ? getDb()
          .select()
          .from(filesTable)
          .where(inArray(filesTable.id, [...missingIds]))
          .all()
      : [];
  if (globalFiles.length > 0) {
    logger.info(
      { tag: "render-verify", op: "render_frames.global_files", pieceId, count: globalFiles.length },
      "render-verify: including files mounted from outside the piece",
    );
  }

  const payload: RenderPayload = {
    overlays,
    audioClips: (manifest.audioClips ?? []) as AudioClip[],
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps,
    files: [...pieceFiles, ...globalFiles],
  };

  // Compute output resolution (capped for speed, no upscale)
  const { width, height } = computeVerifyDims(
    manifest.width,
    manifest.height,
    opts.maxShortSide ?? 720,
  );

  const settings: ExportSettings = {
    format: "mp4",
    codec: "avc",
    bitrate: VERIFY_BITRATE_BPS,
    width,
    height,
    fps: manifest.fps,
  };

  // Prepare output directory
  const outDir = opts.outDir ?? path.join(getLibiStorageDir(), pieceId, "_verify");
  await fs.mkdir(outDir, { recursive: true });

  // Clear stale frame PNGs (best-effort)
  try {
    const existing = await fs.readdir(outDir);
    await Promise.all(
      existing
        .filter((f) => f.startsWith("frame-") && f.endsWith(".png"))
        .map((f) => fs.unlink(path.join(outDir, f)).catch(() => {})),
    );
  } catch {
    // ignore readdir errors (dir may have just been created)
  }

  // Run the Chromium render backend to produce a full-composition MP4
  const backend = new ChromiumRenderBackend();
  const result = await backend.run({
    pieceId,
    composition: stub,  // unused by chromium-render but required by ExportContext
    payload,
    settings,
    onProgress: () => {},
    signal: opts.signal ?? new AbortController().signal,
  });

  // Write the MP4 to a temp file
  const mp4Path = path.join(outDir, `_verify-source-${randomUUID().slice(0, 8)}.mp4`);
  await fs.writeFile(mp4Path, Buffer.from(await result.blob.arrayBuffer()));

  // Extract one PNG per requested timestamp via ffmpeg
  const frames: CapturedFrame[] = [];
  for (const t of times) {
    const outPng = path.join(outDir, `frame-${Math.round(t * 1000)}ms.png`);
    await runFfmpeg(
      ["-y", "-ss", String(t), "-i", mp4Path, "-frames:v", "1", outPng],
      { op: "render_verify_frame" },
    );
    frames.push({ time: t, path: outPng });
  }

  // Clean up the temp MP4; keep PNGs for caller inspection
  await fs.unlink(mp4Path).catch(() => {});

  logger.info(
    {
      tag: "render-verify",
      op: "render_frames",
      pieceId,
      frameCount: frames.length,
      durationMs: Date.now() - startAt,
    },
    "render-verify: done",
  );

  return frames;
}

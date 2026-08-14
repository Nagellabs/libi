/**
 * SAM2-based tracking backend via fal.ai hosted inference.
 *
 * Flow:
 *   1. Load FAL_KEY from DB (mcp_servers row id="fal-ai"), falling back to env.
 *   2. Upload the source video to fal.ai storage (localhost URLs aren't public).
 *   3. Translate libi Anchors into SAM2 box_prompts (x_min/y_min/x_max/y_max).
 *   4. Submit a job to the fal.ai SAM2 queue endpoint.
 *   5. Poll until COMPLETED (with cancellation + synthetic progress ticks).
 *   6. Download the segmented mask video from the result.
 *   7. Decode the mask video with ffmpeg, scan each frame's raw RGB pixels for
 *      the non-black (masked) region, and compute per-frame bounding boxes.
 *   8. Densify to the requested fps if fal returned a different sample rate.
 *
 * ## Verified API contract (2026-05-14)
 *
 * All assumptions in this file were validated against the live fal.ai API.
 * Sources: OpenAPI schema at /api/openapi/queue/openapi.json?endpoint_id=fal-ai/sam2/video,
 *          @fal-ai/client@1.10.1 source, and a live E2E probe run.
 *
 * - Model slug: `fal-ai/sam2/video` — verified correct.
 * - Auth header: `Authorization: Key <FAL_KEY>` — verified (DB row's own headers
 *   use Bearer for the MCP proxy, but direct queue/storage calls use "Key").
 * - Storage upload: POST /storage/upload/initiate?storage_type=fal-cdn-v3
 *   Returns { upload_url, file_url }; then PUT raw bytes to upload_url.
 * - Queue submit: POST https://queue.fal.run/fal-ai/sam2/video
 *   Body: { video_url, box_prompts: [{x_min, y_min, x_max, y_max, frame_index}] }
 *   (box prompts, NOT the `prompts` array which takes point coordinates)
 *   Submit response: { request_id, status_url, response_url, cancel_url, status, ... }
 * - Poll: GET status_url — returns { status: "IN_QUEUE"|"IN_PROGRESS"|"COMPLETED" }
 *   (schema only enumerates these three; FAILED is not in the schema but handled defensively).
 * - Cancel: PUT cancel_url (not DELETE — confirmed by queue.js source + OpenAPI).
 * - Result: GET response_url → { video: { url, content_type, file_name, file_size },
 *   boundingbox_frames_zip?: { url, ... } | null }
 *   NO per-frame JSON bbox/mask data is returned. The video is a segmentation mask
 *   video (masked region as grayscale/colored pixels on black background).
 *
 * ## Bbox extraction strategy
 *
 * Since fal.ai does not return per-frame bbox coordinates, we decode the mask
 * video with ffmpeg to raw RGB and scan each frame's pixels for non-black regions.
 * Threshold: any pixel with R > 20 || G > 20 || B > 20 is considered masked.
 * Frames where no such pixel exists are emitted as invisible samples.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { Transform } from "node:stream";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers, files } from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { serverLogger as logger } from "@/lib/logger";
import { CancelledError } from "@/lib/jobs/types";
import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";
import type { JobContext } from "@/lib/jobs/types";
import type { TrackSample, Anchor } from "@/lib/tracking/types";

// Minimal shape of params that this backend reads — works for both the
// tracking and tracking_provider runner contexts.
export interface Sam2BackendParams {
  fileId: string;
  pieceId: string;
  fileUrl: string;
  fps: number;
  objectKind: "face" | "object";
  anchors: Anchor[];
}

// ---------------------------------------------------------------------------
// Box-prompt builder (exported for tests + refine tool)
// ---------------------------------------------------------------------------

/** Video frame metadata needed to clamp/validate box prompts. */
export interface FrameInfo {
  w: number;
  h: number;
  totalFrames: number;
  fps: number;
}

/** Minimum box side length accepted by the fal.ai SAM2 API. Boxes smaller
 * than this in either dimension trigger HTTP 422 responses. */
const MIN_BOX = 16;

/**
 * Convert libi anchors (x, y, w, h + time) into fal.ai SAM2 box_prompts.
 *
 * Hardens against 422 errors by:
 *  - Enforcing a minimum box size of MIN_BOX pixels per side.
 *  - Clamping coordinates so no corner falls outside the frame.
 *  - Clamping frame_index to [0, totalFrames - 1].
 *
 * For normal (non-degenerate, in-bounds) inputs the output is identical to
 * the old inline mapping:
 *   { x_min: round(x), y_min: round(y), x_max: round(x+w), y_max: round(y+h),
 *     frame_index: round(time * fps) }
 */
export function buildBoxPrompts(
  anchors: { time: number; bbox: [number, number, number, number] }[],
  f: FrameInfo,
): Array<{ x_min: number; y_min: number; x_max: number; y_max: number; frame_index: number }> {
  return anchors.map((a) => {
    const [x, y, w, h] = a.bbox;
    const ww = Math.max(w, MIN_BOX);
    const hh = Math.max(h, MIN_BOX);
    // Clamp top-left so there's room for the minimum box.
    let x1 = Math.round(Math.min(Math.max(0, x), Math.max(0, f.w - MIN_BOX)));
    let y1 = Math.round(Math.min(Math.max(0, y), Math.max(0, f.h - MIN_BOX)));
    const x2 = Math.round(Math.min(f.w, x1 + ww));
    const y2 = Math.round(Math.min(f.h, y1 + hh));
    // If right edge still doesn't clear minimum after top-left clamp, push left edge back.
    if (x2 - x1 < MIN_BOX) x1 = Math.max(0, x2 - MIN_BOX);
    if (y2 - y1 < MIN_BOX) y1 = Math.max(0, y2 - MIN_BOX);
    const fi = Math.min(
      Math.max(0, Math.round(a.time * f.fps)),
      Math.max(0, f.totalFrames - 1),
    );
    return { x_min: x1, y_min: y1, x_max: x2, y_max: y2, frame_index: fi };
  });
}

// ---------------------------------------------------------------------------
// FalClient abstraction (injectable for tests)
// ---------------------------------------------------------------------------

export interface FalClient {
  uploadFile(
    bytes: Buffer | NodeJS.ReadableStream,
    filename: string,
    opts: { key: string; contentType?: string; contentLength?: number },
  ): Promise<{ url: string }>;
  submitJob(
    modelSlug: string,
    body: unknown,
    opts: { key: string },
  ): Promise<{
    request_id: string;
    status_url: string;
    response_url: string;
    cancel_url?: string;
  }>;
  pollStatus(
    statusUrl: string,
    opts: { key: string },
  ): Promise<{ status: string; progress?: number; logs?: unknown[] }>;
  /**
   * Fetch the job result. For fal-ai/sam2/video, the response is:
   *   { video: { url: string, content_type: string, file_name: string, file_size: number },
   *     boundingbox_frames_zip?: { url: string, ... } | null }
   */
  fetchResult(responseUrl: string, opts: { key: string }): Promise<unknown>;
  cancel(cancelUrl: string, opts: { key: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default FAL_KEY loader
// ---------------------------------------------------------------------------

/**
 * Resolve the fal.ai API key.
 *
 * Resolution order (first non-empty value wins):
 *   1. DB: mcp_servers row id="fal-ai", envVars JSON field "FAL_KEY"
 *   2. process.env.FAL_AI_KEY   (matches .env.local convention used by libi dev)
 *   3. process.env.FAL_KEY      (legacy / upstream env naming)
 *
 * The dual-source design means developers can put FAL_AI_KEY in .env.local
 * without having to configure it again in Settings → MCP Servers → fal-ai.
 */
async function defaultLoadFalKey(): Promise<string> {
  // --- Try DB row first (production path) ---
  try {
    const db = getDb();
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.id, "fal-ai")).limit(1);
    const row = rows[0];
    if (row?.envVars) {
      const env = JSON.parse(row.envVars) as Record<string, string>;
      const key = env.FAL_KEY;
      if (key && key.trim()) return key.trim();
    }
  } catch {
    // DB may not be available (tests, CLI mode) — fall through to env.
  }

  // --- Env fallback (dev ergonomics) ---
  const envKey = process.env.FAL_AI_KEY ?? process.env.FAL_KEY;
  if (envKey && envKey.trim()) return envKey.trim();

  throw new Error("fal_ai_not_configured");
}

// ---------------------------------------------------------------------------
// Default fetch-based FalClient
// ---------------------------------------------------------------------------

// Verified 2026-05-14: storage initiate URL with ?storage_type=fal-cdn-v3.
// @fal-ai/client source confirmed: POST /storage/upload/initiate?storage_type=fal-cdn-v3
// Response: { upload_url, file_url }; then PUT raw bytes to upload_url.
const DEFAULT_FAL_BASE = "https://queue.fal.run";
const DEFAULT_FAL_STORAGE = "https://rest.alpha.fal.ai";

const defaultFalClient: FalClient = {
  async uploadFile(bytes, filename, { key, contentType, contentLength }) {
    // Step 1: Initiate upload
    const initRes = await fetch(
      `${DEFAULT_FAL_STORAGE}/storage/upload/initiate?storage_type=fal-cdn-v3`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_name: filename, content_type: contentType ?? "video/mp4" }),
      },
    );
    if (!initRes.ok) {
      throw new Error(`fal storage initiate failed: ${initRes.status} ${await initRes.text()}`);
    }
    const { upload_url, file_url } = (await initRes.json()) as {
      upload_url: string;
      file_url: string;
    };

    // Step 2: PUT the bytes.
    // Production path: stream body directly with Content-Length from fs.statSync — avoids
    // buffering the entire video into RAM (can be 1 GB+). Node 18+ undici requires
    // `duplex: "half"` for streaming request bodies.
    // Fallback: if no contentLength and bytes is already a Buffer, use Uint8Array path.
    let body: BodyInit;
    let headers: Record<string, string> | undefined;
    if (!Buffer.isBuffer(bytes) && contentLength !== undefined) {
      body = bytes as unknown as ReadableStream;
      headers = { "Content-Length": String(contentLength) };
    } else {
      const buf = Buffer.isBuffer(bytes) ? bytes : await streamToBuffer(bytes);
      body = new Uint8Array(buf);
      if (contentLength === undefined && Buffer.isBuffer(bytes)) {
        headers = { "Content-Length": String(Buffer.byteLength(bytes)) };
      }
    }

    const putRes = await fetch(upload_url, {
      method: "PUT",
      body,
      // duplex: "half" is required by Node 18+ undici for streaming request bodies.
      // The standard TS RequestInit type doesn't include this option yet.
      ...(headers ? { headers } : {}),
      ...(!Buffer.isBuffer(bytes) && contentLength !== undefined
        ? { duplex: "half" as never }
        : {}),
    });
    if (!putRes.ok) {
      throw new Error(`fal storage PUT failed: ${putRes.status}`);
    }

    return { url: file_url };
  },

  async submitJob(modelSlug, body, { key }) {
    // Verified 2026-05-14: POST https://queue.fal.run/{modelSlug}
    // Auth: "Authorization: Key <FAL_KEY>" (not Bearer).
    const res = await fetch(`${DEFAULT_FAL_BASE}/${modelSlug}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`fal job submit failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<{
      request_id: string;
      status_url: string;
      response_url: string;
      cancel_url?: string;
    }>;
  },

  async pollStatus(statusUrl, { key }) {
    const res = await fetch(statusUrl, {
      headers: { Authorization: `Key ${key}` },
    });
    if (!res.ok) {
      throw new Error(`fal status poll failed: ${res.status}`);
    }
    return res.json() as Promise<{ status: string; progress?: number; logs?: unknown[] }>;
  },

  async fetchResult(responseUrl, { key }) {
    const res = await fetch(responseUrl, {
      headers: { Authorization: `Key ${key}` },
    });
    if (!res.ok) {
      throw new Error(`fal fetch result failed: ${res.status}`);
    }
    return res.json();
  },

  async cancel(cancelUrl, { key }) {
    // Verified 2026-05-14: cancel uses PUT, not DELETE.
    // OpenAPI path: PUT /fal-ai/sam2/video/requests/{request_id}/cancel
    // Response 200: { success: boolean }
    await fetch(cancelUrl, {
      method: "PUT",
      headers: { Authorization: `Key ${key}` },
    }).catch(() => {
      // Best-effort; ignore errors on cancel.
    });
  },
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface Sam2FalBackendDeps {
  /** Injected for testability. Defaults to the fetch-based client above. */
  falClient?: FalClient;
  /** Injected for testability. Defaults to DB lookup of FAL_KEY. */
  loadFalKey?: () => Promise<string>;
  /** Injected for testability. Defaults to ffmpeg-based pixel scan. */
  extractBboxesFromMaskVideo?: (
    videoUrl: string,
    opts: { fps: number },
  ) => Promise<Array<{ frameIndex: number; t: number; x: number; y: number; w: number; h: number } | null>>;
  /**
   * Injected for testability. Defaults to ffprobe-based frame-info probe.
   * Tests inject a stub that returns safe fallback bounds immediately, avoiding
   * a real ffprobe subprocess under vi.useFakeTimers() which would block the
   * promise chain before sleep() is scheduled, causing runAllTimersAsync() to
   * miss the timer and the test to time out.
   */
  probeFrameInfo?: (videoPath: string, fallbackFps: number) => Promise<FrameInfo>;
}

// Verified 2026-05-14: model slug confirmed at fal.ai/models/fal-ai/sam2/video
const SAM2_MODEL_SLUG = "fal-ai/sam2/video";

// Verified 2026-05-14: fal.ai accepts multiple box_prompts entries.
// Each entry is { x_min, y_min, x_max, y_max, frame_index }.
// Multi-anchor: all anchors are submitted as separate box_prompts entries — SAM2
// will use each as a reference cue on the specified frame.

export async function runSam2FalBackend(
  ctx: JobContext<Sam2BackendParams>,
  deps?: Sam2FalBackendDeps,
): Promise<{ samples: TrackSample[]; framerate: number }> {
  const fal = deps?.falClient ?? defaultFalClient;
  const loadKey = deps?.loadFalKey ?? defaultLoadFalKey;
  const extractBboxes = deps?.extractBboxesFromMaskVideo ?? defaultExtractBboxesFromMaskVideo;
  const doProbeFrameInfo = deps?.probeFrameInfo ?? probeFrameInfo;

  const key = await loadKey();

  const { fileId, pieceId, fps, anchors } = ctx.params;

  // ------------------------------------------------------------------
  // 1. Resolve the local video path
  // ------------------------------------------------------------------
  const db = getDb();
  const fileRows = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
  const file = fileRows[0];
  if (!file) throw new Error(`file not found: ${fileId}`);

  const storage = await getStorage();
  const localPath = storage.localPath(pieceId, file.filename);

  // ------------------------------------------------------------------
  // 2. Upload to fal.ai storage (DB-persisted to survive server restarts)
  // ------------------------------------------------------------------
  let videoUrl: string;
  if (file.falUploadedUrl) {
    // Cache hit: re-use the URL persisted from a previous run.
    videoUrl = file.falUploadedUrl;
    logger.info(
      { tag: "tracking-sam2-fal", op: "sam2_fal.upload.cache_hit", fileId, url: videoUrl },
      "Using persisted fal.ai video URL (skipping re-upload)",
    );
    // NOTE: if fal returns 404/410 during submit/poll, clear falUploadedUrl and retry upload.
  } else {
    logger.info(
      { tag: "tracking-sam2-fal", op: "sam2_fal.upload.start", fileId, pieceId },
      "Uploading source video to fal.ai storage",
    );
    const totalBytes = fs.statSync(localPath).size;
    let uploadedBytes = 0;
    // Pipe through a Transform so progress is counted as undici pulls chunks.
    // Attaching `'data'` directly on the fs.ReadStream would flip it into
    // flowing mode and "disturb" the body before fetch consumes it, causing
    // undici to throw "Response body object should not be disturbed or locked".
    const fileStream = fs.createReadStream(localPath);
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        uploadedBytes += chunk.length;
        ctx.reportProgress(uploadedBytes, totalBytes, "bytes");
        // Chunk-level cancel check — best-effort abort by destroying the
        // pipe. fal.uploadFile rejects when its body source errors out.
        if (ctx.shouldCancel()) {
          cb(new CancelledError(ctx.jobId));
          return;
        }
        cb(null, chunk);
      },
    });
    fileStream.on("error", (err) => counter.destroy(err));
    fileStream.pipe(counter);

    // Wall-clock cancel watcher — if cancel is requested while the upload
    // is mid-flight but no chunks happen to be flowing (slow uplink, network
    // stall), this fires within 1s and tears down the read stream. The
    // chunk-level check above remains the primary path for active uploads.
    const uploadCancelWatcher = setInterval(() => {
      if (ctx.shouldCancel()) {
        try {
          fileStream.destroy(new CancelledError(ctx.jobId));
        } catch {
          /* best-effort */
        }
        try {
          counter.destroy(new CancelledError(ctx.jobId));
        } catch {
          /* best-effort */
        }
      }
    }, 1000);

    let uploaded: { url: string };
    try {
      uploaded = await fal.uploadFile(counter, file.filename, {
        key,
        contentType: file.contentType ?? "video/mp4",
        contentLength: totalBytes,
      });
    } catch (err) {
      // If we tore the stream down on cancel, surface a CancelledError up
      // to the runner (JobManager will mark the row cancelled, not failed).
      if (ctx.shouldCancel()) {
        throw new CancelledError(ctx.jobId);
      }
      throw err;
    } finally {
      clearInterval(uploadCancelWatcher);
    }
    videoUrl = uploaded.url;
    // Persist the URL so future runs (after restarts) skip re-upload.
    await db.update(files).set({ falUploadedUrl: videoUrl }).where(eq(files.id, fileId));
    logger.info(
      { tag: "tracking-sam2-fal", op: "sam2_fal.upload.done", fileId, url: videoUrl },
      "Source video uploaded to fal.ai storage",
    );
    // NOTE: orphaned fal URLs are not cleaned up when a file is deleted from libi.
    // fal.ai URLs expire on their side; no action needed short-term.
  }

  // ------------------------------------------------------------------
  // 3. Probe source video dimensions for prompt hardening
  // ------------------------------------------------------------------

  const frameInfo = await doProbeFrameInfo(localPath, fps);

  // ------------------------------------------------------------------
  // 4. Build SAM2 box_prompts from anchors (hardened against 422 errors)
  //
  // Verified 2026-05-14: fal.ai SAM2 uses SEPARATE box_prompts array with
  // named fields { x_min, y_min, x_max, y_max, frame_index }.
  // (Not the `prompts` array which takes point coordinates { x, y, label, frame_index }.)
  //
  // libi anchors use [x, y, w, h] pixel coords. Converting to corner coords.
  // Multiple anchors are all submitted — SAM2 accepts one or more box_prompts.
  // ------------------------------------------------------------------

  const boxPrompts = buildBoxPrompts(anchors, frameInfo);

  const requestBody = {
    video_url: videoUrl,
    box_prompts: boxPrompts,
    // NOTE: no `fps` field — not part of the SAM2 input schema (verified 2026-05-14).
    // NOTE: not setting `boundingbox_zip: true` — those PNGs are rendered images,
    //   not structured data. We extract bboxes from the mask video directly.
  };

  // ------------------------------------------------------------------
  // 5. Submit job
  // ------------------------------------------------------------------
  const submission = await fal.submitJob(SAM2_MODEL_SLUG, requestBody, { key });
  logger.info(
    {
      tag: "tracking-sam2-fal",
      op: "sam2_fal.submit",
      fileId,
      request_id: submission.request_id,
    },
    "SAM2 job submitted to fal.ai",
  );

  // ------------------------------------------------------------------
  // 6. Poll loop
  // ------------------------------------------------------------------
  const cancelUrl = submission.cancel_url;
  let pollIntervalMs = 2_000;
  const maxIntervalMs = 5_000;
  let lastSyntheticSec = 0;
  const startMs = Date.now();

  while (true) {
    // Break the (possibly multi-second) backoff into ≤1s slices so we can
    // react to ctx.shouldCancel() within ~1s. Semantic backoff is preserved
    // for the actual API poll cadence; we just chunk the wait.
    const sliceMs = 1000;
    let remaining = pollIntervalMs;
    while (remaining > 0) {
      const wait = Math.min(remaining, sliceMs);
      await sleep(wait);
      remaining -= wait;
      if (ctx.shouldCancel()) {
        if (cancelUrl) {
          await fal.cancel(cancelUrl, { key });
        }
        throw new CancelledError(ctx.jobId);
      }
    }
    pollIntervalMs = Math.min(pollIntervalMs * 1.5, maxIntervalMs);

    let statusData: { status: string; progress?: number; logs?: unknown[] };
    try {
      statusData = (await fal.pollStatus(submission.status_url, { key })) as typeof statusData;
    } catch (err) {
      logger.warn(
        { tag: "tracking-sam2-fal", op: "sam2_fal.poll_error", err },
        "SAM2 status poll error — retrying",
      );
      continue;
    }

    const { status, progress } = statusData;

    // Verified 2026-05-14: OpenAPI schema enum is IN_QUEUE | IN_PROGRESS | COMPLETED.
    // FAILED is not in the schema but handle it defensively in case fal adds it.
    if (status === "COMPLETED") {
      break;
    }

    if (status === "FAILED") {
      logger.error(
        {
          tag: "tracking-sam2-fal",
          op: "sam2_fal.failed",
          request_id: submission.request_id,
          logs: statusData.logs,
        },
        "SAM2 job failed on fal.ai",
      );
      const logSummary =
        Array.isArray(statusData.logs) && statusData.logs.length > 0
          ? ` — fal logs: ${JSON.stringify(statusData.logs.slice(-3))}`
          : "";
      throw new Error(
        `SAM2 job failed on fal.ai (request_id=${submission.request_id})${logSummary}`,
      );
    }

    // Emit real progress if available
    if (typeof progress === "number" && isFinite(progress)) {
      ctx.reportProgress(Math.round(progress), 100, "%");
    } else {
      // Emit synthetic progress every ~30s so the no-progress watchdog doesn't fire.
      const elapsedSec = Math.floor((Date.now() - startMs) / 1000);
      if (elapsedSec - lastSyntheticSec >= 30) {
        ctx.reportProgress(elapsedSec, elapsedSec + 1, "s");
        lastSyntheticSec = elapsedSec;
      }
    }
  }

  // ------------------------------------------------------------------
  // 7. Fetch result
  //
  // Verified 2026-05-14: fal.ai SAM2 result shape is:
  //   {
  //     video: { url: string, content_type: string, file_name: string, file_size: number },
  //     boundingbox_frames_zip?: { url: string, ... } | null
  //   }
  //
  // There is NO per-frame JSON bbox or RLE mask data. The `video` is a
  // segmentation mask video where the tracked region appears as non-black pixels
  // on a black background. Per-frame bboxes are extracted by pixel-scanning the
  // decoded video frames (see extractBboxesFromMaskVideo below).
  // ------------------------------------------------------------------

  const rawResult = await fal.fetchResult(submission.response_url, { key });
  const result = rawResult as {
    video?: { url: string; content_type?: string; file_name?: string; file_size?: number };
    boundingbox_frames_zip?: { url: string } | null;
  };

  if (!result.video?.url) {
    logger.error(
      {
        tag: "tracking-sam2-fal",
        op: "sam2_fal.parse.invalid_shape",
        request_id: submission.request_id,
        resultKeys: Object.keys(result),
      },
      "SAM2 response did not include a video URL",
    );
    throw new Error(
      `SAM2 response shape unexpected (no video.url, request_id=${submission.request_id}). fal.ai API may have changed.`,
    );
  }

  logger.info(
    {
      tag: "tracking-sam2-fal",
      op: "sam2_fal.result",
      request_id: submission.request_id,
      videoUrl: result.video.url,
      fileSize: result.video.file_size,
    },
    "SAM2 mask video received from fal.ai",
  );

  // ------------------------------------------------------------------
  // 8. Extract per-frame bboxes from the mask video
  // ------------------------------------------------------------------
  ctx.reportProgress(95, 100, "%");

  const frameResults = await extractBboxes(result.video.url, { fps });

  logger.info(
    {
      tag: "tracking-sam2-fal",
      op: "sam2_fal.bbox_extract",
      request_id: submission.request_id,
      frameCount: frameResults.length,
      visibleCount: frameResults.filter((f) => f !== null).length,
    },
    "Per-frame bboxes extracted from SAM2 mask video",
  );

  // ------------------------------------------------------------------
  // 9. Build TrackSample array
  //
  // For invisible frames (null from extractor), we derive t from the frame's
  // position index and the detected fps from neighbouring visible frames.
  // The extractor stores t on each visible entry; we use the last visible frame's
  // t / index to determine fps, then apply it to invisible frames.
  // ------------------------------------------------------------------

  // Determine the actual fps from the extracted frames (may differ from requested fps
  // when ffmpeg decoded the video at the source frame rate).
  let detectedFps = fps;
  const lastVisible = frameResults.findLast((f) => f !== null);
  if (lastVisible) {
    const lastIdx = frameResults.lastIndexOf(lastVisible);
    if (lastIdx > 0 && lastVisible.t > 0) {
      detectedFps = lastIdx / lastVisible.t;
    }
  }

  const samples: TrackSample[] = frameResults.map((frame, i) => {
    const t = frame !== null ? frame.t : i / (detectedFps > 0 ? detectedFps : fps);
    if (!frame) {
      // Invisible frame — no masked pixel found above threshold in this frame.
      return {
        t,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        confidence: 0,
        visible: false,
        subjectId: null,
      };
    }
    return {
      t,
      x: frame.x,
      y: frame.y,
      w: frame.w,
      h: frame.h,
      confidence: frame.w > 0 && frame.h > 0 ? 1 : 0,
      visible: true,
      subjectId: null,
    };
  });

  // Sort by time (should already be in order from ffmpeg decode, but ensure it)
  samples.sort((a, b) => a.t - b.t);

  // Clamp densified samples to the source clip duration — samples past the
  // clip boundary can appear when the mask video's frame count exceeds the
  // source (encoding artifacts). One extra frame-interval of tolerance is kept
  // so we don't clip legitimate last-frame samples.
  const clipEndSec = frameInfo.totalFrames / (frameInfo.fps > 0 ? frameInfo.fps : fps);
  const frameIntervalSec = 1 / (frameInfo.fps > 0 ? frameInfo.fps : fps);
  const clampedSamples = samples.filter((s) => s.t <= clipEndSec + frameIntervalSec);

  return { samples: clampedSamples, framerate: fps };
}

// ---------------------------------------------------------------------------
// Source video probe (for box-prompt hardening)
// ---------------------------------------------------------------------------

/**
 * Probe the source video to get frame dimensions, frame count, and fps.
 * Used to build safe box_prompts that won't 422 on fal.ai.
 *
 * Falls back to a safe default (1920×1080, 1800 totalFrames) if ffprobe is
 * unavailable or the probe fails — all inputs are clamped to those bounds
 * which is conservative enough to avoid API rejections for any typical clip.
 */
async function probeFrameInfo(videoPath: string, fallbackFps: number): Promise<FrameInfo> {
  try {
    const ffprobePath = resolveFfprobePath();
    const args = [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams", "-show_format",
      "-select_streams", "v:0",
      videoPath,
    ];
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(ffprobePath, args, { maxBuffer: 1024 * 1024 }, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
    });
    const data = JSON.parse(stdout) as {
      streams?: Array<{
        width?: number;
        height?: number;
        nb_frames?: string;
        r_frame_rate?: string;
      }>;
      format?: { duration?: string };
    };
    const s = data.streams?.[0];
    const w = s?.width ?? 0;
    const h = s?.height ?? 0;
    if (!w || !h) throw new Error("no video stream dimensions");

    let fps = fallbackFps;
    if (s?.r_frame_rate) {
      const [num, den] = s.r_frame_rate.split("/").map(Number);
      if (den && num) fps = num / den;
    }

    let totalFrames: number;
    if (s?.nb_frames && s.nb_frames !== "N/A") {
      totalFrames = parseInt(s.nb_frames, 10);
    } else {
      // Derive from duration.
      const duration = parseFloat(data.format?.duration ?? "0");
      totalFrames = Math.round(duration * fps);
    }
    if (totalFrames <= 0) totalFrames = Math.round(60 * fps); // ultimate fallback

    return { w, h, totalFrames, fps };
  } catch (err) {
    logger.warn(
      { tag: "tracking-sam2-fal", op: "sam2_fal.probe_frame_info.error", err },
      "ffprobe frame-info probe failed — using safe fallback bounds",
    );
    // Safe fallback: large enough to contain any typical clip without clamping
    // legitimate coordinates. Box prompts outside these bounds are a bug upstream.
    return { w: 1920, h: 1080, totalFrames: Math.round(60 * fallbackFps), fps: fallbackFps };
  }
}

// ---------------------------------------------------------------------------
// Default bbox extractor: decode mask video with ffmpeg + scan pixels
// ---------------------------------------------------------------------------

/**
 * Download the fal.ai SAM2 mask video, decode it with ffmpeg to raw RGB,
 * and scan each frame for non-black pixels (the masked region).
 *
 * Processes frames one at a time via a streaming pipe to avoid buffering the
 * entire decoded video in memory (which can be many GB for long videos).
 *
 * Returns one entry per decoded frame. Entry is null for invisible frames
 * (no non-black pixel found above threshold).
 *
 * Threshold: pixel with R > 20 || G > 20 || B > 20 is considered part of the mask.
 * This is intentionally conservative to reject H.264 compression artifacts.
 */
async function defaultExtractBboxesFromMaskVideo(
  videoUrl: string,
  opts: { fps: number },
): Promise<Array<{ frameIndex: number; t: number; x: number; y: number; w: number; h: number } | null>> {
  const tmpDir = path.join(os.tmpdir(), `libi-sam2-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpVideo = path.join(tmpDir, "mask.mp4");

  try {
    // Download the mask video
    const dlRes = await fetch(videoUrl);
    if (!dlRes.ok) {
      throw new Error(`Failed to download SAM2 mask video: ${dlRes.status}`);
    }
    const arrBuf = await dlRes.arrayBuffer();
    fs.writeFileSync(tmpVideo, Buffer.from(arrBuf));

    // Probe dimensions and frame rate with ffprobe
    const probeProc = spawnSync(resolveFfmpegPath().replace(/ffmpeg$/, "ffprobe"), [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-select_streams",
      "v:0",
      tmpVideo,
    ]);
    const probeData = JSON.parse(probeProc.stdout?.toString() ?? "{}") as {
      streams?: Array<{ width: number; height: number; nb_frames?: string; r_frame_rate?: string }>;
    };
    const videoStream = probeData.streams?.[0];
    const width = videoStream?.width ?? 0;
    const height = videoStream?.height ?? 0;
    if (!width || !height) {
      throw new Error("Could not probe SAM2 mask video dimensions");
    }

    // Determine frame rate from probe or fall back to requested fps
    let detectedFps = opts.fps;
    if (videoStream?.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
      if (den && num) detectedFps = num / den;
    }

    // Stream-decode frames one at a time to avoid buffering the full decoded video.
    // For a 197s @ 25fps @ 960×540 video that would be ~7.7 GB in memory.
    const frameSize = width * height * 3;
    const MASK_THRESHOLD = 20;
    const results: Array<{
      frameIndex: number;
      t: number;
      x: number;
      y: number;
      w: number;
      h: number;
    } | null> = [];

    await new Promise<void>((resolve, reject) => {
      const ffmpegPath = resolveFfmpegPath();
      const proc = spawn(ffmpegPath, [
        "-i",
        tmpVideo,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
        "-v",
        "quiet",
      ]);

      let pending = Buffer.alloc(0);
      let frameIndex = 0;

      proc.stdout.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);

        while (pending.length >= frameSize) {
          const frameData = pending.slice(0, frameSize);
          pending = pending.slice(frameSize);

          let minX = width;
          let minY = height;
          let maxX = -1;
          let maxY = -1;

          for (let py = 0; py < height; py++) {
            for (let px = 0; px < width; px++) {
              const i = (py * width + px) * 3;
              const r = frameData[i];
              const g = frameData[i + 1];
              const b = frameData[i + 2];
              if (r > MASK_THRESHOLD || g > MASK_THRESHOLD || b > MASK_THRESHOLD) {
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
              }
            }
          }

          const t = frameIndex / detectedFps;

          if (maxX < 0) {
            results.push(null);
          } else {
            results.push({ frameIndex, t, x: minX, y: minY, w: maxX - minX, h: maxY - minY });
          }

          frameIndex++;
        }
      });

      proc.stdout.on("error", reject);
      proc.stderr.on("error", () => {}); // discard stderr

      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0 && results.length === 0) {
          reject(new Error(`ffmpeg exited with code ${String(code)} and produced no frames`));
        } else {
          resolve();
        }
      });
    });

    if (results.length === 0) {
      throw new Error("ffmpeg decoded 0 frames from SAM2 mask video");
    }

    return results;
  } finally {
    // Clean up temp files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

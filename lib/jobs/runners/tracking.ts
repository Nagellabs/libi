import { z } from "zod/v3";
import { once } from "node:events";
import type { JobContext, JobRunner } from "@/lib/jobs/types";
import { CancelledError } from "@/lib/jobs/types";
import type { TrackSample } from "@/lib/tracking/types";
import { runFaceTracker, runObjectTracker } from "@/lib/tracking/mediapipe-runner";
import { runEngineSegment } from "@/lib/tracking/boxmot-runner";
import type { IdentityCandidate } from "@/lib/tracking/boxmot-runner";
import { trackingEngineInstalled, trackingNotInstalledError } from "@/lib/tracking/not-installed";
import { serverLogger as logger } from "@/lib/logger";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";
import { getCurrentPort } from "@/lib/libi-home";
import { assertLoopbackOrPublicHttpUrl } from "@/lib/net/url-guard";
import { fetchFollowingVettedRedirects } from "@/lib/net/follow-redirects";

/**
 * Cap on a video fetched over http(s) into a temp file for the engine
 * sidecar — a server that lies about (or omits) Content-Length can't make
 * us buffer/write an unbounded body; the running counter aborts the
 * in-flight download the moment it's exceeded.
 */
const MAX_TRACKING_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Stream `res`'s body to `destPath`, enforcing `maxBytes` AS the stream
 * arrives (never buffering the whole body first). Mirrors the byte-cap
 * shape of `readBodyWithCap` in `lib/net/fetch-and-store.ts`, but
 * writes straight to disk instead of accumulating a Buffer — this call site
 * carries whole source videos, not the smaller downloads remote-fetch caps.
 */
export async function streamResponseToFileWithCap(
  res: Response,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  const { createWriteStream } = await import("node:fs");

  const body = res.body;
  if (!body) {
    // No stream (empty/bodyless response, e.g. some test mocks).
    const { writeFile } = await import("node:fs/promises");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`video too large: ${buf.byteLength} bytes (max ${maxBytes})`);
    }
    await writeFile(destPath, buf);
    return buf.byteLength;
  }

  const out = createWriteStream(destPath);
  const reader = body.getReader();
  let total = 0;
  let capped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        capped = true;
        throw new Error(`video too large: exceeds ${maxBytes} bytes`);
      }
      if (!out.write(Buffer.from(value))) {
        await once(out, "drain");
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
  } catch (err) {
    out.destroy();
    throw err;
  } finally {
    reader.releaseLock();
    // On a cap breach, cancel the underlying stream so the socket is freed
    // and the remote download is aborted rather than draining in the
    // background.
    if (capped) void body.cancel().catch(() => {});
  }
  return total;
}

// Inputs the runner needs to execute MediaPipe tracking locally.
const trackingParamsSchema = z.object({
  fileId: z.string().min(1),
  pieceId: z.string().min(1),
  fileUrl: z.string().min(1),
  fps: z.number().int().positive(),
  objectKind: z.enum(["face", "object"]),
  method: z.string().min(1).default("mediapipe-object"),
  range: z.object({ start: z.number().nonnegative(), end: z.number().positive() }).optional(),
  classes: z.array(z.string().min(1)).optional(),
  exemplarPath: z.string().optional(),
  // Empty is allowed: a SEEDLESS pure-engine (re)track of a window. The
  // engine (pipeline.py `if not anchors:`) and the legacy mediapipe path
  // (track-entry.ts `anchors.length === 0`) both handle it. This is the
  // "revert to automatic tracking" case — apply-deletes removes the last
  // manual correction in a window and re-tracks it with no seed. (A `.min(1)`
  // here previously forced callers like shot-fanout to pass a throwaway
  // placeholder box just to satisfy validation.)
  anchors: z
    .array(
      z.object({
        fileId: z.string().min(1),
        time: z.number().nonnegative(),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      }),
    )
    .max(100),
});

export type TrackingParams = z.infer<typeof trackingParamsSchema>;

export interface TrackingResult {
  samples: TrackSample[];
  framerate: number;
  /**
   * Only populated for `{ method: "shots" }` shot-detection runs (the fan-out
   * bridge). Carries the clip's detected shot ranges; `samples` is `[]`.
   */
  shots?: { start: number; end: number }[];
  /**
   * Only populated for `{ method: "ground" }` Stage-0 grounding runs.
   * Carries NUMBERED candidate boxes at the requested frame; `samples` is `[]`.
   */
  candidates?: { index: number; bbox: number[]; label: string; conf: number }[];
  /**
   * Only populated for `{ method: "candidates" }` identity-candidates runs.
   * Carries the competing tracklets ranked best-first; `samples` is `[]`.
   */
  candidateTracklets?: IdentityCandidate[];
}

interface TrackingResumeState {
  framesDone: number;
  partialSamples: TrackSample[];
}

export const trackingRunner: JobRunner<TrackingParams, TrackingResult> = {
  kind: "tracking",
  mcpToolId: [
    makeMcpToolId("libi", "libi.compute_object_track"),
    makeMcpToolId("libi-tracking", "libi.compute_object_track"),
  ],
  maxConcurrent: 1,
  // `.default("mediapipe-object")` on `method` makes the schema's input type
  // differ from its output type, which doesn't satisfy `ZodSchema<P>`. Same
  // cast pattern as export-render.ts — JobManager always `.parse()`s before
  // `run()`, so `ctx.params` is the fully-defaulted output type.
  paramsSchema: trackingParamsSchema as unknown as z.ZodSchema<TrackingParams>,
  resumable: true,
  noProgressTimeoutMs: 60_000,
  async run(ctx: JobContext<TrackingParams>): Promise<TrackingResult> {
    const prior = (ctx.resumeState as TrackingResumeState | null) ?? null;
    const startFrame = prior?.framesDone ?? 0;
    const priorSamples = prior?.partialSamples ?? [];

    const opts = {
      fileUrl: ctx.params.fileUrl,
      fileId: ctx.params.fileId,
      pieceId: ctx.params.pieceId,
      fps: ctx.params.fps,
      anchors: ctx.params.anchors,
      jobId: ctx.jobId,
      startFrame,
      priorSamples,
      onProgress: (done: number, total: number) => {
        ctx.reportProgress(done, total, "frames");
      },
      onCheckpoint: async (state: TrackingResumeState) => {
        await ctx.checkpoint(state);
      },
      shouldCancel: () => ctx.shouldCancel(),
    };

    const ENGINE_METHODS = new Set([
      "yoloe+botsort",
      "yoloe-text",
      "sot",
      "shots",
      "ground",
      "candidates",
    ]);
    let out: TrackingResult;
    if (ENGINE_METHODS.has(ctx.params.method)) {
      if (!trackingEngineInstalled()) {
        throw new Error(JSON.stringify(trackingNotInstalledError()));
      }
      // cv2.VideoCapture is unreliable on http(s) URLs — resolve to a local
      // readable path. If fileUrl is http(s), download to a temp file first.
      let localVideo = ctx.params.fileUrl;
      let tmpToClean: string | null = null;
      if (/^https?:\/\//i.test(localVideo)) {
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");

        // SSRF guard: `fileUrl` traces back to a caller-supplied value (the
        // route validates it too, but this runner is also reachable via
        // POST /api/jobs directly, so it re-validates rather than trusting
        // an upstream check it can't see). The one legitimate non-public
        // shape is a loopback url on THIS app's own port.
        //
        // Redirects are followed MANUALLY, re-running the same guard on
        // EVERY hop (not just this initial url) — a bare `fetch(vetted, …)`
        // defaults to `redirect: "follow"`, which would let a public-looking
        // host 302 straight to a private/loopback address that was never
        // checked. Shared with remote-fetch.ts's identical requirement; see
        // `lib/net/follow-redirects.ts`.
        const ownPort = getCurrentPort();
        const res = await fetchFollowingVettedRedirects(localVideo, (raw) =>
          assertLoopbackOrPublicHttpUrl(raw, ownPort),
        );
        if (!res.ok) throw new Error(`fetch video failed: ${res.status}`);
        tmpToClean = join(tmpdir(), `libitrack-${ctx.jobId}.mp4`);
        // Stream to disk with a running byte cap rather than buffering the
        // whole video via arrayBuffer() — a multi-GB source clip must not
        // be held entirely in process memory.
        const bytes = await streamResponseToFileWithCap(
          res,
          tmpToClean,
          MAX_TRACKING_VIDEO_BYTES,
        );
        localVideo = tmpToClean;
        logger.info(
          { tag: "tracking-engine", op: "http_to_tmp", jobId: ctx.jobId, tmp: tmpToClean, bytes },
          "downloaded http video to temp file for sidecar",
        );
      }
      try {
        const r = await runEngineSegment({
          videoPath: localVideo,
          fps: ctx.params.fps,
          range: ctx.params.range ?? { start: 0, end: Number.MAX_SAFE_INTEGER },
          method: ctx.params.method,
          classes: ctx.params.classes ?? ["person"],
          anchors: ctx.params.anchors.map((a) => ({ time: a.time, bbox: a.bbox })),
          headRefine: ctx.params.objectKind === "face",
          exemplarPath: ctx.params.exemplarPath,
          onProgress: (d, t) => ctx.reportProgress(d, t, "frames"),
          onCheckpoint: (s) => ctx.checkpoint(s),
          shouldCancel: () => ctx.shouldCancel(),
        });
        out = {
          samples: r.samples,
          framerate: r.framerate,
          shots: r.shots,
          candidates: r.candidates,
          candidateTracklets: r.candidateTracklets,
        };
      } finally {
        if (tmpToClean) {
          const { unlink } = await import("node:fs/promises");
          await unlink(tmpToClean).catch(() => {});
        }
      }
    } else {
      out =
        ctx.params.objectKind === "face"
          ? await runFaceTracker(opts)
          : await runObjectTracker(opts);
    }

    if (ctx.shouldCancel()) throw new CancelledError(ctx.jobId);

    return {
      samples: out.samples,
      framerate: out.framerate,
      shots: out.shots,
      candidates: out.candidates,
      candidateTracklets: out.candidateTracklets,
    };
  },
};

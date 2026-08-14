//
// Next.js-SERVER-ONLY. Imports getJobManager(). NEVER import this from any
// file under mcp/ (process-boundary rule — see CLAUDE.md "Cross-process
// invocation"). The MCP child re-tracks via runJobViaServer instead.
import { eq } from "drizzle-orm";
import { files } from "@/lib/db/schema/sqlite";
import { getCurrentPort } from "@/lib/libi-home";
import { getJobManager } from "@/lib/jobs/manager";
import { readTrack } from "@/lib/tracking/storage";
import { reanchorWindow, REANCHOR_WINDOW_SEC } from "@/lib/tracking/manual-anchors";
import { applySegmentResult } from "@/lib/tracking/apply-segment-result";
import { serverLogger as logger } from "@/lib/logger";
import type { ManualAnchor, TrackSample, TrackMethod } from "@/lib/tracking/types";
import { summarizeTrack } from "@/lib/tracking/summary";
import { rejectWrongSubjectRuns } from "@/lib/tracking/reject-wrong-subject";
import { rejectAnchorInconsistentBoxes } from "@/lib/tracking/reject-anchor-inconsistent";
import { fillNoDetectionFromAnchors } from "@/lib/tracking/fill-no-detection";
import { normalizeTrack } from "@/lib/tracking/segments";

export interface RecomputeTrackSegmentArgs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  fileId: string;
  trackId: string;
  /** The manual-anchor time that triggered this re-track. */
  time: number;
  /** All manual anchors on the track (the engine seeds with the in-range ones). */
  manualAnchors: ManualAnchor[];
  /**
   * Classes to pass to the tracking engine. Defaults to ["person"]. Segment
   * classes aren't persisted on the track yet, so a caller that knows the
   * original track was a non-person (yoloe-text) track should pass `classes`
   * explicitly. Known limitation for v1 (person/face is the primary re-anchor
   * case).
   */
  classes?: string[];
}

export interface RecomputeDeps {
  /** Injected in tests; defaults to the real JobManager path. */
  runJob?: (
    kind: "tracking",
    params: Record<string, unknown>,
  ) => Promise<{ samples: TrackSample[]; framerate: number }>;
}

async function defaultRunJob(
  kind: "tracking",
  params: Record<string, unknown>,
): Promise<{ samples: TrackSample[]; framerate: number }> {
  const jm = getJobManager();
  // Manual re-anchor always wants a fresh recompute — `forceNew` matches the
  // old `resume: false` semantics.
  const result = await jm.enqueue(kind, params, { forceNew: true });
  // `forceNew: true` always returns a `new` (forced) result; narrow for TS.
  if (result.status !== "new") {
    throw new Error(`unexpected enqueue result for forced re-track: ${result.status}`);
  }
  const res = await jm.runToCompletion<{ samples: TrackSample[]; framerate: number }>(result.jobId);
  return res;
}

/**
 * Seeded re-track of the segment containing `time`, with the in-range manual
 * anchors fed as engine anchors. Upserts the segment in place; siblings
 * untouched. Returns the recompute outcome incl. the fresh summary.
 */
export async function recomputeTrackSegmentServerSide(
  args: RecomputeTrackSegmentArgs,
  deps: RecomputeDeps = {},
): Promise<{ trackId: string; segmentId: string; summary: ReturnType<typeof summarizeTrack> }> {
  const runJob = deps.runJob ?? defaultRunJob;

  const fileRows = await args.db.select().from(files).where(eq(files.id, args.fileId)).limit(1);
  const file = fileRows[0];
  if (!file?.pieceId) throw new Error("file must be assigned to a piece");

  const track = await readTrack(file.pieceId, args.trackId);
  if (!track) throw new Error(`track sidecar missing: ${args.trackId}`);

  const okSegs = (track.segments ?? []).filter((s) => s.status === "ok");
  const containing = okSegs.find((s) => args.time >= s.startTime && args.time <= s.endTime);
  const nearest =
    containing ??
    okSegs
      .slice()
      .sort(
        (a, b) =>
          Math.min(Math.abs(args.time - a.startTime), Math.abs(args.time - a.endTime)) -
          Math.min(Math.abs(args.time - b.startTime), Math.abs(args.time - b.endTime)),
      )[0];
  const method = (nearest?.method ?? "yoloe+botsort") as TrackMethod;
  const objectKind = (nearest?.objectKind ?? "object") as "face" | "object";

  // A manual re-anchor is a LOCAL correction. Bound the re-track to ±W around
  // the pin and never spill outside the containing OK segment, so one pin
  // can't re-track (and a failed engine pass can't destroy) the whole clip.
  // Shared with the route's retrack dedup — they MUST use the same window.
  const range = reanchorWindow(track, args.time, REANCHOR_WINDOW_SEC);

  const inRange = args.manualAnchors.filter((a) => a.time >= range.start && a.time <= range.end);
  const anchors = inRange.map((a) => ({ fileId: args.fileId, time: a.time, bbox: a.bbox }));

  logger.info(
    { tag: "tracking-reanchor", op: "reanchor.recompute.start", trackId: args.trackId,
      range, method, anchorCount: anchors.length },
    "manual re-anchor seeded re-track starting",
  );

  const out = await runJob("tracking", {
    fileId: args.fileId,
    pieceId: file.pieceId,
    fileUrl: `http://127.0.0.1:${getCurrentPort()}/api/files/by-id/${args.fileId}/content`,
    fps: track.framerate || 30, // 0/null/NaN framerate → 30
    objectKind,
    method,
    range,
    classes: args.classes ?? ["person"],
    anchors,
  });

  const segmentId = `seg-${Math.round(range.start * 1000)}-${Math.round(range.end * 1000)}`;

  // Write-path appearance gate: a re-track that locked a DIFFERENT subject
  // emits visible boxes with sustained targetSim < APPEARANCE_TAU. Never
  // render those — blank them, then ride the user's pin through.
  const scrubbed = rejectWrongSubjectRuns(out.samples);

  // Appearance-INDEPENDENT positional gate: on crowded footage the OSNet
  // template is non-discriminative (a cameraman can score targetSim ~0.9),
  // so rejectWrongSubjectRuns is blind. The user's manual anchors are
  // literal ground truth — blank any box whose center has clearly jumped
  // away from the interpolated anchor trajectory, regardless of targetSim.
  const anchorGated = rejectAnchorInconsistentBoxes({
    samples: scrubbed,
    anchors,
    range,
  });

  // No-regress: where the (post-gate) re-track has no detection but the
  // PRIOR derived track was visible OR an in-range anchor asserts the
  // subject, interpolate from the in-range manual anchors so a manual pin
  // can never make the window disappear (and rides through the boxes the
  // positional gate just rejected).
  const prior = normalizeTrack(track).samples ?? track.samples ?? [];
  const filled = fillNoDetectionFromAnchors({
    newSamples: anchorGated,
    priorSamples: prior,
    anchors,
    range,
  });
  const fixedOut = { ...out, samples: filled };

  // Only bail (keep prior, upsert nothing) if even after fill there is
  // genuinely nothing visible — i.e. no prior coverage AND no anchor.
  const anyVisible = filled.some((s) => s.visible);
  if (!anyVisible) {
    logger.warn(
      { tag: "tracking-reanchor", op: "reanchor.recompute.lost", trackId: args.trackId, range },
      "seeded re-track found no visible subject — keeping prior samples (manual pin still applies)",
    );
    const t = await readTrack(file.pieceId, args.trackId);
    const summary = summarizeTrack(
      t ?? {
        id: args.trackId,
        fileId: file.id,
        framerate: track.framerate || 30,
        method,
        durationSec: track.durationSec,
        samples: track.samples,
      },
      {
        frameW: file.mediaWidth ?? 1,
        frameH: file.mediaHeight ?? 1,
        clipDurationSec: file.mediaDuration ?? Infinity,
      },
    );
    return { trackId: args.trackId, segmentId, summary };
  }

  const applied = await applySegmentResult({
    db: args.db,
    file: {
      id: file.id, pieceId: file.pieceId,
      mediaWidth: file.mediaWidth, mediaHeight: file.mediaHeight, mediaDuration: file.mediaDuration,
    },
    trackId: args.trackId,
    range,
    method,
    objectKind,
    provenance: "manual",
    out: fixedOut,
  });

  logger.info(
    { tag: "tracking-reanchor", op: "reanchor.recompute.done", trackId: args.trackId,
      segmentId: applied.segmentId },
    "manual re-anchor seeded re-track done",
  );
  return applied;
}

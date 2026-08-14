import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files, mcpServers } from "@/lib/db/schema/sqlite";
import { deleteTrackRow, listTracksByFile, getTrackRow } from "@/lib/tracking/repo";
import { deleteTrack as deleteTrackFile } from "@/lib/tracking/storage";
import { getCurrentPort } from "@/lib/libi-home";
import {
  addOverlayToManifest,
  updateOverlayInManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";
import type {
  ComputeObjectTrackParams,
  ComputeObjectTrackProvidersParams,
  DeleteTrackParams,
  ListTracksParams,
  AddTrackedOverlayParams,
  UpdateTrackedOverlayParams,
  UpdateTrackResultParams,
  ComputeTrackSegmentParams,
  SkipSegmentParams,
  ListTrackSegmentsParams,
  GroundTargetParams,
  ListIdentityCandidatesParams,
  PickCandidateParams,
  RefineTrackWithSam2Params,
  VerifyInstallParams,
  VerifyTrackedOverlayParams,
} from "@/mcp/tools/schemas";
import {
  refineAtLeastOneAnchorSource,
  REFINE_ANCHOR_MESSAGE,
} from "@/mcp/tools/schemas";
import type { TrackMethod, Anchor } from "@/lib/tracking/types";
import { serverLogger as logger } from "@/lib/logger";
import { requireDeps, markDepInstalled, type MissingDep } from "@/lib/dependencies/require-deps";
import { trackingEngineInstalled } from "@/lib/tracking/not-installed";
import {
  runJobViaServer,
  legacyTripleFromRunJobResult,
  LibiServerUnavailableError,
} from "@/mcp/jobs-client";
import { CancelledError } from "@/lib/jobs/types";
import type { TrackSample } from "@/lib/tracking/types";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types";
import { deriveAnchors, mergeAnchors } from "@/lib/analysis/manager";
import { newTrackId, saveTrackSamples } from "@/lib/tracking/save-track";
import { upsertSegment } from "@/lib/tracking/segment-store";
import { summarizeTrack } from "@/lib/tracking/summary";
import { applySegmentResult, shouldPersistLostSegment } from "@/lib/tracking/apply-segment-result";
import { mixedBoxSemantics, dominantObjectKind } from "@/lib/tracking/segments";
import { overlayCodeRelPath } from "@/lib/overlays/paths";
import { readTrack, writeTrack } from "@/lib/tracking/storage";
import { agentAnchorId, upsertAgentAnchor } from "@/lib/tracking/manual-anchors";
import { detectShotRanges } from "@/lib/tracking/shot-fanout";
import { groundCandidates } from "@/lib/tracking/ground";
import type { IdentityCandidate } from "@/lib/tracking/identity-candidates";
import { annotateFrame } from "@/lib/tracking/annotate-frame";
import type { FileRecord } from "@/lib/db/schema/types";
import { isTestMode } from "@/lib/test-mode";

// Tracking tools use the canonical generic result type. Aliased locally as
// `ToolResult` so the many `ToolResult<…>` annotations below are unchanged,
// but NOT re-exported — the barrel must expose only one `ToolResult`
// (the loose `./types` one), which killed the prior dual-declaration collision.
import type { ToolResultOf as ToolResult } from "./types";

// Flags that indicate a track is too broken to attach an overlay without
// explicit agent acknowledgement. `samples_exceed_clip_duration` is intentionally
// absent: honest-output guards strip post-duration samples at save time, so it
// cannot appear in a persisted track — it is a harness-only diagnostic signal.
// `appearance_unverified_occlusion` is intentionally NOT here: it means an
// explicit anchor asserts the subject through a low-similarity window
// (back-to-camera/occlusion) — honest and non-blocking by design.
const BLOCKING_QUALITY_FLAGS = new Set([
  "no_output",
  "low_visibility",
  "identity_switch_suspected",
  "edge_pinned",
  "full_canvas_while_visible",
  "oversized_box_while_visible",
]);

/** Test-only export — the gate logic reads the private set; tests assert its
 *  membership without reaching into module internals. */
export const BLOCKING_QUALITY_FLAGS_FOR_TEST: ReadonlySet<string> = BLOCKING_QUALITY_FLAGS;

/** Build the `qualityWarning` string for a finished shot fan-out. A
 *  `total === 0` (or `no_output`-flagged) summary is an ENGINE MISS — the
 *  pipeline bound the subject in 0 frames across all shots — and gets an
 *  explicit isolate-and-surface instruction, NOT the generic per-window
 *  repair text (there are no windows to repair). Pure. */
export function engineMissWarning(
  summary: ReturnType<typeof summarizeTrack>,
): string | undefined {
  const engineMiss = summary.total === 0 || summary.flags.includes("no_output");
  if (engineMiss) {
    return (
      "ENGINE PRODUCED NO TRACK — the pipeline bound the subject in 0 frames across all shots. Do NOT " +
      "add_tracked_overlay and do NOT hand-animate a keyframe overlay as a fallback. Isolate the cause: run " +
      "ground_target at 2-3 in-clip timestamps. If it returns the subject at high confidence, this is a LOCAL " +
      "ENGINE failure on this footage — tell the user and offer method:'sot' (single-object template tracking, " +
      "bypasses the detector/associate path) or the paid SAM2 provider (refine_track_with_sam2). See the " +
      "using-object-tracking skill's 'zero output' rule."
    );
  }
  if (summary.issues.length > 0) {
    return (
      "TRACK QUALITY ISSUES DETECTED — do NOT add_tracked_overlay yet. For each entry in " +
      "summary.issues, repair that exact `range`: ground_target in-range then " +
      "compute_track_segment with a tight anchor, or skip_segment if the subject is genuinely " +
      "gone. Re-check until summary.issues is empty. Tip: a single anchor is fragile — prefer " +
      "compute_object_track with derivedFromSubjectName for dense analysis-derived anchors."
    );
  }
  return undefined;
}

function fileUrlFor(fileId: string): string {
  // Let getCurrentPort() throw if the port file is missing — runJobViaServer's
  // resolveBaseUrl will surface LibiServerUnavailableError downstream either
  // way, so failing fast here keeps errors consistent.
  return `http://127.0.0.1:${getCurrentPort()}/api/files/by-id/${fileId}/content`;
}

async function resolveAnchors(params: {
  file: { id: string };
  anchors?: Anchor[];
  derivedFromSubjectName?: string;
  derivedFromItemName?: string;
  manualAnchors?: { time: number; bbox: [number, number, number, number] }[];
}): Promise<{ resolvedAnchors: Anchor[] } | { error: string; data: { hint: string } }> {
  const manual: Anchor[] = (params.manualAnchors ?? []).map((m) => ({
    fileId: params.file.id, time: m.time, bbox: m.bbox,
  }));
  if (params.derivedFromSubjectName || params.derivedFromItemName) {
    const { anchors: derived, rejectedCount } = await deriveAnchors({
      fileId: params.file.id,
      subjectName: params.derivedFromSubjectName,
      itemName: params.derivedFromItemName,
    });
    // Priority (highest → lowest): stored manual > params.anchors > derived.
    // Manual anchors are user ground truth — they literally pointed at the subject.
    // Two sequential merges because mergeAnchors(first, second) always keeps first on collision:
    //   step 1: params.anchors win over derived
    //   step 2: stored manual win over everything
    const step1 = mergeAnchors(params.anchors ?? [], derived);
    const resolvedAnchors = mergeAnchors(manual, step1);
    logger.info(
      {
        tag: "tracking-derive-anchors",
        op: "merge",
        fileId: params.file.id,
        explicitAnchors: (params.anchors ?? []).length,
        derived: derived.length,
        storedManualAnchors: manual.length,
        merged: resolvedAnchors.length,
        rejected: rejectedCount,
      },
      "tracking anchors merged",
    );
    if (resolvedAnchors.length === 0) {
      return {
        error: "no_anchors_available",
        data: {
          hint: "Analysis has no keyframes with a bbox for this subject. Re-run analysis with bbox extraction, or pass manual `anchors`.",
        },
      };
    }
    return { resolvedAnchors };
  }
  // Non-derive branch: union in manual anchors if any are present.
  // Priority (highest → lowest): stored manual > params.anchors.
  // Using conditional form to guarantee zero behavior change when no manual anchors exist
  // (mergeAnchors(xs, []) sorts xs which is safe but unnecessary churn).
  if (manual.length > 0) {
    // manual is first arg so it wins over params.anchors on time-collision.
    return { resolvedAnchors: mergeAnchors(manual, params.anchors ?? []) };
  }
  return { resolvedAnchors: params.anchors ?? [] };
}

// ---------------------------------------------------------------------------
// Shared compute helper — the common flow for both tracking variants.
// ---------------------------------------------------------------------------

type TrackingCommonOpts = {
  params: ComputeObjectTrackParams | ComputeObjectTrackProvidersParams;
  runnerKind: "tracking" | "tracking_provider";
  // Build the runner-specific extra fields to merge into the job params.
  extraJobParams: Record<string, unknown>;
  // Derive the track method from objectKind (and optionally provider).
  methodFor: (objectKind: "face" | "object") => TrackMethod;
  // Tag for structured log calls — kept separate so local vs provider logs differ.
  logTag: string;
  startOp: string;
  doneOp: string;
  startMessage: string;
  doneMessage: string;
  // Extra fields logged on start (e.g. provider name).
  startLogExtra?: Record<string, unknown>;
  doneLogExtra?: Record<string, unknown>;
  // Optional dep check — skipped when undefined.
  checkDeps?: () => { missing: MissingDep[] } | null;
  // Optional test-mode gate — returns structured error when blocked.
  testModeCheck?: () => ToolResult<never, { hint: string }> | null;
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>;
};

async function runTrackingCommon(opts: TrackingCommonOpts): Promise<
  ToolResult<
    {
      trackId: string;
      jobId: string;
      sampleCount: number;
      resumed: boolean;
      clientKey?: string;
      forced?: true;
      attachedToRunning?: true;
      matchedExisting?: true;
      existingJob?: unknown;
    },
    | { missing: MissingDep[]; hint: string }
    | { hint: string }
    | { jobId: string }
  >
> {
  // The MCP `inputSchema` is the raw shape (so the agent sees every
  // parameter); the cross-field "≥1 anchor source" rule that used to live in
  // a `.refine()` is enforced here instead.
  if (!refineAtLeastOneAnchorSource(opts.params)) {
    return {
      success: false,
      error: "no_anchors_available",
      data: { hint: REFINE_ANCHOR_MESSAGE },
    };
  }

  // Optional test-mode gate (providers only).
  if (opts.testModeCheck) {
    const blocked = opts.testModeCheck();
    if (blocked) return blocked;
  }

  // Optional dep check (local MediaPipe only).
  if (opts.checkDeps) {
    const result = opts.checkDeps();
    if (result) {
      return {
        success: false,
        error: "dependency_not_ready",
        data: {
          missing: result.missing,
          hint: "Open Settings → MCP Servers → Libi to see status / retry.",
        },
      };
    }
  }

  const { params } = opts;
  const db = getDb();
  const fileRows = await db.select().from(files).where(eq(files.id, params.fileId)).limit(1);
  const file = fileRows[0];
  if (!file) return { success: false, error: `file not found: ${params.fileId}` };
  if (!file.pieceId) return { success: false, error: "file must be assigned to a piece" };

  const trackId = newTrackId();
  const fps = params.fps ?? 30;

  const anchorsResult = await resolveAnchors({
    file,
    anchors: params.anchors,
    derivedFromSubjectName: params.derivedFromSubjectName,
    derivedFromItemName: params.derivedFromItemName,
  });
  if ("error" in anchorsResult) {
    return { success: false, ...anchorsResult };
  }
  const { resolvedAnchors } = anchorsResult;

  logger.info(
    {
      tag: opts.logTag,
      op: opts.startOp,
      trackId,
      fileId: file.id,
      fps,
      anchorCount: resolvedAnchors.length,
      ...opts.startLogExtra,
    },
    opts.startMessage,
  );

  const clientKey = randomUUID();
  let resp: Awaited<
    ReturnType<
      typeof runJobViaServer<{ samples: TrackSample[]; framerate: number }>
    >
  >;
  try {
    resp = await runJobViaServer<{ samples: TrackSample[]; framerate: number }>(
      opts.runnerKind,
      {
        fileId: file.id,
        pieceId: file.pieceId,
        fileUrl: fileUrlFor(file.id),
        fps,
        objectKind: params.objectKind,
        anchors: resolvedAnchors,
        ...opts.extraJobParams,
      },
      {
        extra: opts.extra,
        forceNew: params.forceNew === true,
        clientKey,
        pieceId: file.pieceId,
        fileId: file.id,
      },
    );
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return { success: false, error: "libi_server_unavailable", data: { hint: err.hint } };
    }
    if (err instanceof CancelledError) {
      return { success: false, error: "cancelled", data: { jobId: err.jobId } };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err), data: { jobId: "" } };
  }

  const method: TrackMethod = opts.methodFor(params.objectKind);

  // Per-shape dispatch — track samples are persisted regardless, so the
  // matchedExisting/attachedToRunning branches still produce a usable trackId.
  switch (resp.status) {
    case "new": {
      const out = resp.result;
      await saveTrackSamples({
        trackId,
        fileId: file.id,
        samples: out.samples,
        framerate: out.framerate,
        method,
        subjectId: params.subjectId,
        label: params.label,
        anchors: resolvedAnchors,
      });
      logger.info(
        {
          tag: opts.logTag,
          op: opts.doneOp,
          trackId,
          jobId: resp.jobId,
          resumed: false,
          sampleCount: out.samples.length,
          ...opts.doneLogExtra,
        },
        opts.doneMessage,
      );
      const forced =
        "forced" in resp && resp.forced === true ? { forced: true as const } : {};
      return {
        success: true,
        data: {
          trackId,
          jobId: resp.jobId,
          sampleCount: out.samples.length,
          resumed: false,
          clientKey: resp.clientKey,
          ...forced,
        },
      };
    }
    case "attached_running": {
      const out = resp.result;
      await saveTrackSamples({
        trackId,
        fileId: file.id,
        samples: out.samples,
        framerate: out.framerate,
        method,
        subjectId: params.subjectId,
        label: params.label,
        anchors: resolvedAnchors,
      });
      logger.info(
        {
          tag: opts.logTag,
          op: opts.doneOp,
          trackId,
          jobId: resp.jobId,
          resumed: true,
          sampleCount: out.samples.length,
          attachedToRunning: true,
          ...opts.doneLogExtra,
        },
        opts.doneMessage,
      );
      return {
        success: true,
        data: {
          trackId,
          jobId: resp.jobId,
          sampleCount: out.samples.length,
          resumed: true,
          clientKey: resp.clientKey,
          attachedToRunning: true,
          existingJob: resp.existingJob,
        },
      };
    }
    case "matching_completed": {
      // Cached terminal row — we re-persist the cached samples under the
      // freshly-generated trackId so that the trackId returned to the caller
      // points to a real row + JSON sidecar. Without this, the agent would
      // immediately hit "track not found" when calling add_tracked_overlay.
      const cached =
        (resp.existingJob.result ?? {}) as {
          samples?: TrackSample[];
          framerate?: number;
        };
      if (!cached.samples || !Array.isArray(cached.samples) || cached.samples.length === 0) {
        logger.warn(
          {
            tag: opts.logTag,
            op: opts.doneOp,
            jobId: resp.existingJob.jobId,
            matchedExisting: true,
            cachedSampleCount: cached.samples?.length ?? 0,
          },
          "matching_completed cached job has no usable samples; surfacing error so caller can retry with forceNew",
        );
        return {
          success: false,
          error: "cached_result_unusable",
          data: {
            hint: "Cached matching job had no samples; retry with forceNew: true to recompute.",
          },
        };
      }
      await saveTrackSamples({
        trackId,
        fileId: file.id,
        samples: cached.samples,
        framerate: cached.framerate ?? fps,
        method,
        subjectId: params.subjectId,
        label: params.label,
        anchors: resolvedAnchors,
      });
      logger.info(
        {
          tag: opts.logTag,
          op: opts.doneOp,
          trackId,
          jobId: resp.existingJob.jobId,
          sampleCount: cached.samples.length,
          matchedExisting: true,
          ...opts.doneLogExtra,
        },
        opts.doneMessage,
      );
      return {
        success: true,
        data: {
          trackId,
          jobId: resp.existingJob.jobId,
          sampleCount: cached.samples.length,
          resumed: true,
          matchedExisting: true,
          existingJob: resp.existingJob,
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Public tool functions
// ---------------------------------------------------------------------------

/**
 * Track a subject across the whole clip via SHOT FAN-OUT:
 *  1. detect shots (one sidecar run in `method: "shots"` mode)
 *  2. compute one `yoloe+botsort` segment per detected shot, stitched into a
 *     single segmented Track (ids never bleed across shot boundaries)
 *  3. summarize the stitched track
 *
 * A bad window can be recomputed later with `libi.compute_track_segment`.
 * Returns `{ trackId, segments, summary }`.
 */
export async function computeObjectTrack(
  params: ComputeObjectTrackParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<
  ToolResult<
    {
      trackId: string;
      segments: Array<{ id: string; range: { start: number; end: number } }>;
      summary: ReturnType<typeof summarizeTrack>;
      /** Present when the track needs attention BEFORE an overlay is
       *  attached — an ENGINE MISS (zero frames bound: `summary.total === 0`
       *  or the `no_output` flag → isolate-and-surface instruction) or a
       *  non-empty `summary.issues` (per-window repair instruction). Built
       *  by `engineMissWarning`. */
      qualityWarning?: string;
    },
    | { missing: MissingDep[]; hint: string }
    | { hint: string }
    | { jobId: string }
  >
> {
  // The MCP `inputSchema` is the raw shape (so the agent sees every
  // parameter); the cross-field "≥1 anchor source" rule that used to live in
  // a `.refine()` is enforced here instead.
  if (!refineAtLeastOneAnchorSource(params)) {
    return {
      success: false,
      error: "no_anchors_available",
      data: { hint: REFINE_ANCHOR_MESSAGE },
    };
  }

  const db = getDb();

  // Gate on the tracking python env (uv venv + ONNX models) — the engine
  // pipeline (shot detection + yoloe+botsort) requires it.
  //
  // DISK is authoritative, not the DB flag. The on-disk `.install-token`
  // (written by the installer) is the ground truth: a server restart
  // re-seeds the `libi` row and reverts the `tracking-pyenv`
  // dependencyStatus to not-installed even though the ~1 GB engine is
  // sitting on disk fully usable. The old DB-only gate therefore returned
  // a FALSE `dependency_not_ready` after every restart, and the agent —
  // pointed at "Settings → MCP Servers" / a now-defunct libi-tracking MCP
  // — burned many turns diagnosing/retrying/waiting instead of just
  // proceeding. If the engine is on disk we proceed AND self-heal the DB
  // row so Settings + future reads reflect reality (no verify_install
  // dance, for every user, every restart).
  const libiRows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, "libi"))
    .limit(1);
  if (libiRows.length > 0) {
    if (trackingEngineInstalled()) {
      // Engine present on disk — heal the DB flag and proceed.
      try {
        if (requireDeps("libi", ["tracking-pyenv"]).length > 0) {
          markDepInstalled("libi", "tracking-pyenv");
        }
      } catch {
        /* best-effort heal; never block a usable engine on a DB write */
      }
    } else {
      const missing = requireDeps("libi", ["tracking-pyenv"]);
      if (missing.length > 0) {
      return {
        success: false,
        error: "dependency_not_ready",
        data: {
          missing,
          hint:
            "The libi-tracking engine isn't installed. Recover with: libi.verify_install " +
            "(if it returns ok:true you're done — retry this call); otherwise libi.get_install_plan " +
            "(id 'libi-tracking') and run the install, then libi.verify_install, then retry. " +
            "Do NOT diagnose/retry a 'libi-tracking' MCP — tracking tools are hosted by core libi; " +
            "only the Python engine is installed lazily.",
        },
      };
      }
    }
  }

  const fileRows = await db.select().from(files).where(eq(files.id, params.fileId)).limit(1);
  const file = fileRows[0];
  if (!file) return { success: false, error: `file not found: ${params.fileId}` };
  if (!file.pieceId) return { success: false, error: "file must be assigned to a piece" };

  const anchorsResult = await resolveAnchors({
    file,
    anchors: params.anchors,
    derivedFromSubjectName: params.derivedFromSubjectName,
    derivedFromItemName: params.derivedFromItemName,
  });
  if ("error" in anchorsResult) {
    return { success: false, ...anchorsResult };
  }
  const { resolvedAnchors } = anchorsResult;

  const fps = params.fps ?? 30;
  const trackId = newTrackId();

  try {
    let shots = await detectShotRanges(fileUrlFor(file.id), fps, file.pieceId, file.id, extra);
    if (shots.length === 0) {
      shots = [{ start: 0, end: file.mediaDuration ?? Number.MAX_SAFE_INTEGER }];
    }

    logger.info(
      {
        tag: "tracking-compute",
        op: "tracking.compute.fanout.start",
        trackId,
        fileId: file.id,
        fps,
        shots: shots.length,
        anchorCount: resolvedAnchors.length,
      },
      "Compute object track fan-out started",
    );

    // The first per-shot computeTrackSegment call creates the segmented track
    // (it always passes this trackId); subsequent shots upsert into it.
    const segments: Array<{ id: string; range: { start: number; end: number } }> = [];
    let shotIndex = 0;
    for (const shot of shots) {
      shotIndex++;
      const inShot = resolvedAnchors.filter(
        (a) => a.time >= shot.start && a.time < shot.end,
      );
      // KNOWN LIMITATION: when a shot has no in-range anchor we pass ALL
      // anchors, but the sidecar's anchor gate (pipeline.py:
      // `abs(near.time - t) <= 2/fps`) can only fire for an anchor whose time
      // lands inside this segment's frames — an out-of-range anchor never
      // seeds the bind, and cross-shot identity carry does NOT cross separate
      // sidecar processes. So an anchorless shot honestly reports `lost`
      // (Task P0-B4 now persists that instead of discarding it) and is
      // repaired via the diagnostic loop. A future improvement is to auto-
      // ground one anchor per anchorless shot (deriveAnchors' one-frame YOLOE
      // synthesis path); not done here to keep this fix focused.
      const chosen = inShot.length > 0 ? inShot : resolvedAnchors;
      const segRes = await computeTrackSegment(
        {
          fileId: file.id,
          trackId,
          range: shot,
          method: "yoloe+botsort",
          classes: params.classes ?? ["person"],
          objectKind: params.objectKind,
          anchors: chosen,
          fps,
          label: params.label,
          subjectId: params.subjectId,
          // Shot fan-out lays down the lowest-tier engine SEED. An explicit
          // agent repair (standalone compute_track_segment, default "agent")
          // must be able to authoritatively replace any of these windows.
          provenance: "engine",
          progressLabel: `segment ${shotIndex}/${shots.length}`,
          // MUST propagate. Without it `compute_object_track({ forceNew: true })`
          // creates a fresh trackId but every per-shot job still dedupes on its
          // unchanged paramsHash and replays the previous run's CACHED samples.
          // Measured 2026-08-02: a 3-shot fan-out that takes ~29s of real engine
          // work "completed" in 19ms and returned the earlier run's empty
          // samples — so an engine fix looked like it had changed nothing, and
          // any transient failure would be replayed forever with no way for the
          // agent to escape it.
          forceNew: params.forceNew === true,
        },
        extra,
      );
      if (segRes.success) {
        segments.push({ id: segRes.data!.segmentId, range: shot });
      }
    }

    const track = await readTrack(file.pieceId, trackId);
    const trackForSummary: import("@/lib/tracking/types").Track = track ?? {
      id: trackId,
      fileId: file.id,
      framerate: fps,
      method: "yoloe+botsort",
      durationSec: file.mediaDuration ?? 0,
      samples: [],
    };
    const summary = summarizeTrack(trackForSummary, {
      frameW: file.mediaWidth ?? 1,
      frameH: file.mediaHeight ?? 1,
      clipDurationSec: file.mediaDuration ?? Infinity,
    });

    logger.info(
      {
        tag: "tracking-compute",
        op: "tracking.compute.fanout.done",
        trackId,
        segmentCount: segments.length,
      },
      "Compute object track fan-out done",
    );

    // Surface quality problems as an explicit, actionable instruction in
    // the result itself — not just data the agent might skip. A track
    // that switched subjects or has frame-filling boxes must be REPAIRED
    // (per-window) before any overlay is attached, otherwise the user
    // sees the emoji jump to a cameraman / balloon for a moment.
    const qualityWarning = engineMissWarning(summary);

    return {
      success: true,
      data: { trackId, segments, summary, ...(qualityWarning ? { qualityWarning } : {}) },
    };
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return { success: false, error: "libi_server_unavailable", data: { hint: err.hint } };
    }
    if (err instanceof CancelledError) {
      return { success: false, error: "cancelled", data: { jobId: err.jobId } };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      data: { jobId: "" },
    };
  }
}

export async function computeObjectTrackProviders(
  params: ComputeObjectTrackProvidersParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<
  ToolResult<
    { trackId: string; jobId: string; sampleCount: number; resumed: boolean },
    | { hint: string }
    | { jobId: string }
  >
> {
  return runTrackingCommon({
    params,
    runnerKind: "tracking_provider",
    extraJobParams: { provider: params.provider },
    // Real provider calls must never happen in test mode — return a structured
    // error so the agent falls back to local MediaPipe.
    testModeCheck: () =>
      isTestMode()
        ? {
            success: false,
            error: "providers_disabled_in_test_mode",
            data: { hint: "Use libi.compute_object_track instead, or unset LIBI_TEST_MODE." },
          }
        : null,
    // Method label is the provider name — matches TrackMethod's open string union.
    methodFor: () => params.provider,
    logTag: "tracking-compute",
    startOp: "tracking_provider.compute.start",
    doneOp: "tracking_provider.compute.done",
    startMessage: "Compute object track (provider) started",
    doneMessage: "Compute object track (provider) done",
    startLogExtra: { provider: params.provider },
    doneLogExtra: { provider: params.provider },
    extra,
  });
}

export async function listTracks(
  params: ListTracksParams,
): Promise<
  ToolResult<{
    tracks: Array<{
      id: string;
      label?: string;
      method: string;
      sampleCount: number;
      durationSec: number;
    }>;
  }>
> {
  const db = getDb();
  const rows = await listTracksByFile(db, params.fileId);
  return {
    success: true,
    data: {
      tracks: rows.map((r) => ({
        id: r.id,
        label: r.label ?? undefined,
        method: r.method,
        sampleCount: r.sampleCount,
        durationSec: r.durationSec,
      })),
    },
  };
}

export async function deleteTrack(
  params: DeleteTrackParams,
): Promise<ToolResult<{ pieceId?: string }>> {
  const db = getDb();
  const row = await getTrackRow(db, params.trackId);
  if (!row) return { success: false, error: `track not found: ${params.trackId}` };
  const fileRows = await db.select().from(files).where(eq(files.id, row.fileId)).limit(1);
  const pieceId = fileRows[0]?.pieceId ?? undefined;
  if (pieceId) {
    await deleteTrackFile(pieceId, row.id);
  }
  await deleteTrackRow(db, row.id);
  return { success: true, data: { pieceId } };
}

function newOverlayId() {
  return `tracked-${randomUUID().split("-")[0]}`;
}

export async function addTrackedOverlay(
  params: AddTrackedOverlayParams,
): Promise<ToolResult<{ overlayId: string; codeFilePath?: string }, { summary: ReturnType<typeof summarizeTrack> }>> {
  const db = getDb();
  const row = await getTrackRow(db, params.trackId);
  if (!row) return { success: false, error: `track not found: ${params.trackId}` };

  // Quality gate — refuse to attach to a degenerate track unless the agent
  // has explicitly inspected the issues and passed acknowledgeQualityIssues:true.
  const fileRows = await db.select().from(files).where(eq(files.id, row.fileId)).limit(1);
  const file = fileRows[0];
  if (file?.pieceId) {
    const track = await readTrack(file.pieceId, params.trackId);
    if (track) {
      // Only run the gate when both dimensions are known — mirroring the same
      // trade-off in lib/tracking/save-track.ts. With frameW=1/frameH=1 every
      // real box looks full-canvas and the gate would permanently refuse a
      // perfectly good track just because the file lacks media metadata.
      const frameW = file.mediaWidth;
      const frameH = file.mediaHeight;
      if (frameW && frameH) {
        const summary = summarizeTrack(track, {
          frameW,
          frameH,
          clipDurationSec: file.mediaDuration ?? Number.POSITIVE_INFINITY,
        });
        const blocking = summary.flags.filter((f) => BLOCKING_QUALITY_FLAGS.has(f));
        if (blocking.length > 0 && params.acknowledgeQualityIssues !== true) {
          return {
            success: false,
            error:
              `Refusing to attach: track ${params.trackId} has blocking quality issues ` +
              `[${blocking.join(", ")}]. Fix the flagged ranges (compute_track_segment / skip_segment) ` +
              `then retry, or pass acknowledgeQualityIssues:true if you have deliberately decided to attach anyway.`,
            data: { summary },
          };
        }
        // Mixed box-semantics gate: face (head-box) and object (body-box) segments
        // cannot share one overlay `fit` — refuse unless explicitly acknowledged.
        if (track.segments && mixedBoxSemantics(track.segments) && params.acknowledgeQualityIssues !== true) {
          return {
            success: false,
            error:
              `Refusing to attach: track ${params.trackId} mixes face (head-box) and object (body-box) ` +
              `segments — one fit cannot be correct for both. Recompute the body-box windows with ` +
              `objectKind:"face" (compute_track_segment), or attach separate overlays per range with the right fit.`,
            data: { summary },
          };
        }
      }
    }
  } else {
    logger.warn(
      { trackId: params.trackId, fileId: row.fileId },
      "add_tracked_overlay quality gate skipped: file has no pieceId",
    );
  }

  const id = newOverlayId();
  const overlay: PersistedOverlay = {
    id,
    kind: "tracked",
    startTime: params.startTime,
    duration: params.duration,
    rect: params.rect,
    z: params.z,
    opacity: params.opacity,
    trackId: params.trackId,
    content: params.content,
    fit: params.fit,
    scale: params.scale,
    smoothing: params.smoothing,
    ...(params.sizeMode !== undefined ? { sizeMode: params.sizeMode } : {}),
    ...(params.maxBoxScale !== undefined ? { maxBoxScale: params.maxBoxScale } : {}),
    ...(params.positionMode !== undefined ? { positionMode: params.positionMode } : {}),
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
  };
  await addOverlayToManifest(params.pieceId, overlay);
  logger.info(
    { event: "add", pieceId: params.pieceId, overlayId: id, trackId: params.trackId },
    "overlay.add.tracked",
  );
  // For code-kind tracked content, the persistence seam wrote content.jsx;
  // return its path so the agent can edit the draw function directly.
  const codeFilePath =
    params.content.kind === "code" ? overlayCodeRelPath(id, "content.jsx") : undefined;
  return { success: true, data: { overlayId: id, ...(codeFilePath ? { codeFilePath } : {}) } };
}

export async function updateTrackedOverlay(
  params: UpdateTrackedOverlayParams,
): Promise<ToolResult<{ overlayId: string }>> {
  const { pieceId, overlayId, ...patch } = params;
  const cleanPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) cleanPatch[k] = v;
  const ok = await updateOverlayInManifest(pieceId, overlayId, cleanPatch as never);
  if (!ok) return { success: false, error: `overlay ${overlayId} not found` };
  return { success: true, data: { overlayId } };
}

// ---------------------------------------------------------------------------
// Per-segment composable tracking tools
// ---------------------------------------------------------------------------

export async function computeTrackSegment(
  // `provenance` is an INTERNAL stitch-precedence concern, deliberately NOT on
  // the agent-facing Zod schema: a standalone `libi.compute_track_segment`
  // call is a corrective repair and must authoritatively outrank the engine
  // seed (default "agent"); only the `computeObjectTrack` shot fan-out passes
  // "engine" so its per-shot seed segments stay the lowest tier. Without this,
  // every agent repair tied the seed at "engine" and won its window only by a
  // createdAt/span accident — the lisa-13 24s cameraman-wobble root cause.
  params: ComputeTrackSegmentParams & {
    provenance?: "engine" | "agent";
    /** Chat progress prefix set by the shot fan-out (e.g. "segment 2/7"). */
    progressLabel?: string;
  },
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<
  ToolResult<
    { trackId: string; segmentId: string; jobId: string; summary: ReturnType<typeof summarizeTrack> },
    { hint: string } | { jobId: string }
  >
> {
  const db = getDb();
  const fileRows = await db.select().from(files).where(eq(files.id, params.fileId)).limit(1);
  const file = fileRows[0];
  if (!file) return { success: false, error: `file not found: ${params.fileId}` };
  if (!file.pieceId) return { success: false, error: "file must be assigned to a piece" };

  const trackId = params.trackId ?? newTrackId();

  // First read: stored manual anchors for the engine seed; applySegmentResult reads again for the upsert (different call frame).
  const existingForAnchors = params.trackId
    ? await readTrack(file.pieceId, params.trackId)
    : null;
  const manualForRun = (existingForAnchors?.manualAnchors ?? [])
    .filter((m) => m.time >= params.range.start && m.time <= params.range.end)
    .map((m) => ({ fileId: file.id, time: m.time, bbox: m.bbox }));
  const agentForRun = (existingForAnchors?.agentAnchors ?? [])
    .filter((a) => a.time >= params.range.start && a.time <= params.range.end)
    .map((a) => ({ fileId: file.id, time: a.time, bbox: a.bbox }));

  // Priority (highest → lowest) for computeTrackSegment's own anchor concat:
  // stored manual > params.anchors. manualForRun is the highest-trust signal
  // (user literally pointed at the subject), so we drop any params.anchors entry
  // whose time collides with a manualForRun entry (within 0.1s epsilon) before
  // concatenating — this ensures exactly one anchor per time, with stored manual winning.
  const MERGE_EPSILON_S = 0.1;
  const collides = (
    list: Array<{ time: number }>,
    t: number,
  ) => list.some((m) => Math.abs(m.time - t) < MERGE_EPSILON_S);
  // Precedence manual > agent > params: drop params that collide with manual
  // or agent; drop agent that collides with manual. Highest trust is forwarded
  // LAST so it wins after any remaining dedup downstream.
  const deduplicatedParamAnchors = (params.anchors ?? []).filter(
    (a) => !collides(manualForRun, a.time) && !collides(agentForRun, a.time),
  );
  const deduplicatedAgentAnchors = agentForRun.filter(
    (a) => !collides(manualForRun, a.time),
  );

  let jobId: string;
  let out: { samples: TrackSample[]; framerate: number };

  try {
    const resp = await runJobViaServer<{ samples: TrackSample[]; framerate: number }>(
      "tracking",
      {
        fileId: file.id,
        pieceId: file.pieceId,
        fileUrl: fileUrlFor(file.id),
        fps: params.fps ?? 30,
        objectKind: params.objectKind ?? "object",
        method: params.method,
        range: params.range,
        classes: params.classes ?? ["person"],
        // Stored manual anchors come last so no collision remains after dedup above.
        // The combined array has no duplicate times, and manualForRun wins over params.anchors.
        anchors: [...deduplicatedParamAnchors, ...deduplicatedAgentAnchors, ...manualForRun],
      },
      {
        extra,
        forceNew: params.forceNew === true,
        pieceId: file.pieceId,
        fileId: file.id,
        ...(params.progressLabel
          ? {
              toolHint: {
                toolName: "libi.compute_object_track",
                toolArgs: {},
                progressLabel: params.progressLabel,
              },
            }
          : {}),
      },
    );
    const ran = legacyTripleFromRunJobResult(resp);
    jobId = ran.jobId;
    out = ran.result;
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return { success: false, error: "libi_server_unavailable", data: { hint: err.hint } };
    }
    if (err instanceof CancelledError) {
      return { success: false, error: "cancelled", data: { jobId: err.jobId } };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Persist the agent's in-range corrective anchors to the TRANSPARENT
  // agentAnchors channel — ONLY when correcting an existing track. The render
  // override (mergeAnchorOverridesIntoTrack) force-stamps them and they
  // re-seed subsequent re-tracks (agentForRun). Never on initial build.
  //
  // ORDER MATTERS: this runs BEFORE the summarize/apply below, because
  // `summarizeTrack`'s oversize relaxation reads all three anchor channels.
  // Persisting afterwards meant the summary returned by THIS call judged the
  // new samples against the OLD anchor set — so a repair that deliberately
  // re-pointed at a large subject was reported as oversized, and only a
  // second, redundant call would come back clean.
  if (params.trackId) {
    const inRange = (params.anchors ?? []).filter(
      (a) => a.time >= params.range.start && a.time <= params.range.end,
    );
    if (inRange.length > 0) {
      const cur = await readTrack(file.pieceId, trackId);
      if (cur) {
        let agentAnchors = cur.agentAnchors ?? [];
        for (const a of inRange) {
          agentAnchors = upsertAgentAnchor(agentAnchors, {
            id: agentAnchorId(a.time), time: a.time, bbox: a.bbox,
          });
        }
        await writeTrack(file.pieceId, { ...cur, agentAnchors });
      }
    }
  }

  // NEVER MAKE WORSE (ported from lib/tracking/recompute-segment.ts): if the
  // engine found no visible subject in the window, do NOT upsert a "lost"
  // segment over the (presumably better) prior samples. The persisted
  // agentAnchors still render-stamp + re-seed, so the correction is not lost.
  const anyVisible = out.samples.some((s) => s.visible);
  // The skip applies ONLY when a prior segment OVERLAPPING this range has
  // visible samples inside it (real data worth protecting) — NOT merely when
  // the track row exists. Keying off row existence silently dropped every
  // all-lost shot after the first in the shot fan-out (shot 1 creates the
  // row, shots 2..N then hit the skip and vanish — the portrait "seven empty
  // tracks" bug, round 2). In every other all-lost case — fresh window, or
  // an overlapping prior that is itself lost/empty — persist the honest
  // `lost` segment so list_track_segments shows reality.
  const priorTrack = await readTrack(file.pieceId, trackId);
  let appliedSegmentId: string;
  let summary: ReturnType<typeof summarizeTrack>;
  if (!anyVisible && !shouldPersistLostSegment(priorTrack, params.range)) {
    logger.warn(
      { tag: "tracking-compute", op: "tracking.segment.recompute.lost", trackId,
        range: params.range },
      "seeded re-track found no visible subject — keeping prior samples (agent anchors still applied)",
    );
    appliedSegmentId = `seg-${Math.round(params.range.start * 1000)}-${Math.round(params.range.end * 1000)}`;
    summary = summarizeTrack(
      priorTrack ?? {
        id: trackId, fileId: file.id, framerate: out.framerate || 30,
        method: params.method, durationSec: file.mediaDuration ?? 0, samples: [],
      },
      {
        frameW: file.mediaWidth ?? 1,
        frameH: file.mediaHeight ?? 1,
        clipDurationSec: file.mediaDuration ?? Infinity,
      },
    );
  } else {
    const applied = await applySegmentResult({
      db,
      file: {
        id: file.id, pieceId: file.pieceId,
        mediaWidth: file.mediaWidth, mediaHeight: file.mediaHeight, mediaDuration: file.mediaDuration,
      },
      trackId,
      range: params.range,
      method: params.method,
      objectKind: (params.objectKind ?? "object") as "face" | "object",
      out,
      provenance: params.provenance ?? "agent",
      subjectId: params.subjectId,
      label: params.label,
      anchors: params.anchors,
    });
    appliedSegmentId = applied.segmentId;
    summary = applied.summary;
  }

  logger.info(
    { tag: "tracking-compute", op: "tracking.segment.done", trackId, segmentId: appliedSegmentId, jobId, sampleCount: out.samples.length },
    "Compute track segment done",
  );

  return { success: true, data: { trackId, segmentId: appliedSegmentId, jobId, summary } };
}

export async function skipSegment(
  params: SkipSegmentParams,
): Promise<ToolResult<{ trackId: string; segmentId: string }>> {
  const segmentId = `seg-${Math.round(params.range.start * 1000)}-${Math.round(params.range.end * 1000)}`;
  try {
    await upsertSegment(params.trackId, {
      id: segmentId,
      startTime: params.range.start,
      endTime: params.range.end,
      method: "skip",
      status: "skipped",
      samples: [],
      reason: params.reason,
      // A skip is a deliberate agent decision — it must replace an engine
      // segment's window at write time (upsertSegment overlap resolution)
      // and win the stitch, exactly like a compute_track_segment repair.
      provenance: "agent",
      createdAt: Date.now(),
    });
    return { success: true, data: { trackId: params.trackId, segmentId } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listTrackSegments(
  params: ListTrackSegmentsParams,
): Promise<
  ToolResult<{
    segments: Array<{
      id: string;
      startTime: number;
      endTime: number;
      method: string;
      status: string;
      sampleCount: number;
      visible: number;
      reason?: string;
    }>;
    manualAnchors: Array<{ time: number; bbox: [number, number, number, number] }>;
    manualAnchorCount: number;
    agentAnchors: Array<{ time: number; bbox: [number, number, number, number] }>;
    agentAnchorCount: number;
  }>
> {
  const db = getDb();
  const row = await getTrackRow(db, params.trackId);
  if (!row) return { success: false, error: `track not found: ${params.trackId}` };

  const fileRows = await db.select().from(files).where(eq(files.id, row.fileId)).limit(1);
  const pieceId = fileRows[0]?.pieceId;
  if (!pieceId) return { success: false, error: "track file has no piece" };

  const track = await readTrack(pieceId, params.trackId);
  if (!track) return { success: false, error: `track sidecar not found: ${params.trackId}` };

  const segments = (track.segments ?? []).map((seg) => ({
    id: seg.id,
    startTime: seg.startTime,
    endTime: seg.endTime,
    method: String(seg.method),
    status: seg.status,
    sampleCount: seg.samples.length,
    visible: seg.samples.filter((s) => s.visible).length,
    ...(seg.reason !== undefined ? { reason: seg.reason } : {}),
  }));

  const manualAnchors = (track.manualAnchors ?? []).map((a) => ({ time: a.time, bbox: a.bbox }));
  const agentAnchors = (track.agentAnchors ?? []).map((a) => ({ time: a.time, bbox: a.bbox }));
  return { success: true, data: { segments, manualAnchors, manualAnchorCount: manualAnchors.length, agentAnchors, agentAnchorCount: agentAnchors.length } };
}

export async function updateTrackResult(
  params: UpdateTrackResultParams,
): Promise<ToolResult<{ trackId: string; samplesWritten: number; replaced: boolean }>> {
  const trackId = params.trackId ?? newTrackId();
  try {
    const result = await saveTrackSamples({
      trackId,
      fileId: params.fileId,
      samples: params.samples as TrackSample[],
      framerate: params.framerate,
      method: params.method,
      subjectId: params.subjectId,
      label: params.label,
      anchors: params.anchors,
    });
    logger.info(
      { tag: "tracking-update-result", op: "tracking.update_result.done", trackId: result.trackId, fileId: params.fileId, samplesWritten: result.sampleCount, replaced: result.replaced },
      "Update track result completed",
    );
    return {
      success: true,
      data: { trackId: result.trackId, samplesWritten: result.sampleCount, replaced: result.replaced },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { tag: "tracking-update-result", op: "tracking.update_result.error", trackId, fileId: params.fileId, err },
      "Update track result failed",
    );
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Stage-0 grounding (set-of-marks)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SAM2 mask-refinement tool (opt-in, PAID via fal.ai)
// ---------------------------------------------------------------------------

/**
 * Refine an existing box track into precise SAM2 masks over an optional time
 * range.  This is NOT a tracker — it takes an already-computed box track as
 * input and uses fal.ai SAM2 to produce accurate segmentation masks for the
 * same subject.  Adds a "sam2-refine" segment to the track.
 *
 * Usage flow:
 *   1. Run libi.compute_object_track (local, free) to get a box track.
 *   2. Optionally call this tool if you need precise masks for matting /
 *      object replacement — only after the user approves the fal.ai cost.
 */
export async function refineTrackWithSam2(
  params: RefineTrackWithSam2Params,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<
  ToolResult<
    { trackId: string; jobId: string; segmentId: string },
    { hint: string } | { jobId: string }
  >
> {
  // Test-mode gate — same pattern as computeObjectTrackProviders.
  if (isTestMode()) {
    return {
      success: false,
      error: "providers_disabled_in_test_mode",
      data: { hint: "Use libi.compute_object_track instead, or unset LIBI_TEST_MODE." },
    };
  }

  const db = getDb();
  const row = await getTrackRow(db, params.trackId);
  if (!row) return { success: false, error: `track not found: ${params.trackId}` };

  const fileRows = await db.select().from(files).where(eq(files.id, row.fileId)).limit(1);
  const file = fileRows[0];
  if (!file) return { success: false, error: `source file not found for track: ${params.trackId}` };
  if (!file.pieceId) return { success: false, error: "track's source file must be assigned to a piece" };

  // Load the track sidecar to derive sparse anchors from visible samples.
  const track = await readTrack(file.pieceId, params.trackId);
  if (!track) return { success: false, error: `track sidecar not found: ${params.trackId}` };

  // Filter to visible samples within range.
  const rangeStart = params.range?.start;
  const rangeEnd = params.range?.end;
  const visibleInRange = track.samples.filter((s) => {
    if (!s.visible) return false;
    if (rangeStart !== undefined && s.t < rangeStart) return false;
    if (rangeEnd !== undefined && s.t > rangeEnd) return false;
    return true;
  });

  if (visibleInRange.length === 0) {
    return {
      success: false,
      error: "no_visible_samples_to_refine",
      data: {
        hint:
          "No visible track samples in the requested range. Expand the range or compute the track first.",
      },
    };
  }

  // Derive sparse anchors (≤8) evenly spaced across the visible samples.
  const MAX_ANCHORS = 8;
  const step = Math.max(1, Math.floor(visibleInRange.length / MAX_ANCHORS));
  const anchorSamples = visibleInRange.filter((_, i) => i % step === 0).slice(0, MAX_ANCHORS);
  const anchors: { fileId: string; time: number; bbox: [number, number, number, number] }[] =
    anchorSamples.map((s) => ({
      fileId: file.id,
      time: s.t,
      bbox: [s.x, s.y, s.w, s.h] as [number, number, number, number],
    }));

  const firstVisibleT = visibleInRange[0].t;
  const lastVisibleT = visibleInRange[visibleInRange.length - 1].t;

  const fps = track.framerate ?? 30;
  const segmentId = `seg-sam2-refine-${Math.round((rangeStart ?? firstVisibleT) * 1000)}`;

  let jobId: string;
  let out: { samples: import("@/lib/tracking/types").TrackSample[]; framerate: number };

  try {
    const resp = await runJobViaServer<{
      samples: import("@/lib/tracking/types").TrackSample[];
      framerate: number;
    }>(
      "tracking_provider",
      {
        fileId: file.id,
        pieceId: file.pieceId,
        fileUrl: fileUrlFor(file.id),
        fps,
        objectKind: "object" as const,
        anchors,
        provider: "sam2-fal",
      },
      {
        extra,
        resume: true,
        pieceId: file.pieceId,
        fileId: file.id,
      },
    );
    const ran = legacyTripleFromRunJobResult(resp);
    jobId = ran.jobId;
    out = ran.result;
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return { success: false, error: "libi_server_unavailable", data: { hint: err.hint } };
    }
    if (err instanceof CancelledError) {
      return { success: false, error: "cancelled", data: { jobId: err.jobId } };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      data: { jobId: "" },
    };
  }

  // Inherit the parent track's box-semantics class so this refine segment
  // never spuriously trips mixedBoxSemantics (e.g. refining a face track
  // must stay "face", not silently default to "object").
  const inheritedObjectKind = dominantObjectKind(track.segments ?? []);

  await upsertSegment(params.trackId, {
    id: segmentId,
    startTime: rangeStart ?? firstVisibleT,
    endTime: rangeEnd ?? lastVisibleT,
    method: "sam2-refine",
    status: out.samples.some((s) => s.visible) ? "ok" : "lost",
    samples: out.samples,
    objectKind: inheritedObjectKind,
    // Explicitly-requested paid refinement — same authority as an agent
    // repair: replaces the engine window it covers instead of coexisting
    // with it (upsertSegment overlap resolution keys off provenance rank).
    provenance: "agent",
    createdAt: Date.now(),
  });

  logger.info(
    {
      tag: "tracking-compute",
      op: "tracking.refine_sam2.done",
      trackId: params.trackId,
      segmentId,
      jobId,
      sampleCount: out.samples.length,
    },
    "Refine track with SAM2 done",
  );

  return { success: true, data: { trackId: params.trackId, jobId, segmentId } };
}

// ---------------------------------------------------------------------------
// Stage-0 grounding (set-of-marks)
// ---------------------------------------------------------------------------

export async function groundTarget(
  params: GroundTargetParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<
  ToolResult<{
    candidates: { index: number; bbox: number[]; label: string; conf: number }[];
    frameUrl: string;
    annotatedFileId?: string;
  }>
> {
  const db = getDb();
  const fileRows = await db.select().from(files).where(eq(files.id, params.fileId)).limit(1);
  const file = fileRows[0];
  if (!file) return { success: false, error: `file not found: ${params.fileId}` };
  if (!file.pieceId) return { success: false, error: "file must be assigned to a piece" };

  try {
    const cands = await groundCandidates(
      fileUrlFor(file.id),
      params.time,
      params.classes ?? ["person"],
      file.pieceId,
      file.id,
      extra,
    );

    let annotatedFileId: string | undefined;
    if (cands.length > 0) {
      try {
        const annotated = await annotateFrame({
          sourceFile: file as FileRecord,
          time: params.time,
          boxes: cands.map((c) => ({
            x: c.bbox[0], y: c.bbox[1], w: c.bbox[2], h: c.bbox[3],
            label: `#${c.index} ${c.label}`,
          })),
          name: `ground-${params.fileId.slice(0, 8)}-${params.time.toFixed(2)}s`,
        });
        annotatedFileId = annotated.id;
      } catch (e) {
        logger.warn({ tag: "tracking-ground", op: "ground_annotate", err: e instanceof Error ? e.message : String(e) }, "annotate_frame_failed");
      }
    }

    return {
      success: true,
      data: {
        candidates: cands,
        frameUrl: `${fileUrlFor(file.id)}#t=${params.time}`,
        ...(annotatedFileId !== undefined ? { annotatedFileId } : {}),
      },
    };
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return { success: false, error: "libi_server_unavailable", data: { hint: err.hint } };
    }
    if (err instanceof CancelledError) {
      return { success: false, error: "cancelled", data: { jobId: err.jobId } };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Identity-candidate disambiguation (list + pick)
// ---------------------------------------------------------------------------

/** The concrete drizzle client `getDb()` returns — also exactly what the
 *  `createTestDb()` harness injects via the `_db` seam, so this tightening
 *  stays faithful to both call paths without an `any`. */
type AnyDb = ReturnType<typeof getDb>;

/** Sort candidates highest appearance-match first; nulls (ReID-off) last.
 *  Identical to the Task-2 bridge's ordering (kept inline; the bridge does
 *  not export a shared sorter). */
function sortCandidatesBySim(cands: IdentityCandidate[]): IdentityCandidate[] {
  return cands.slice().sort((a, b) => (b.meanTargetSim ?? -1) - (a.meanTargetSim ?? -1));
}

/** Resolve a track's file + piece + in-range anchors. Mirrors
 *  `listTrackSegments`' track→file resolution and `computeTrackSegment`'s
 *  in-range manual∪agent anchor derivation. */
async function resolveTrackForCandidates(
  db: AnyDb,
  trackId: string,
  range: { start: number; end: number },
): Promise<
  | {
      ok: true;
      file: FileRecord;
      pieceId: string;
      anchors: { fileId: string; time: number; bbox: [number, number, number, number] }[];
    }
  | { ok: false; error: string }
> {
  const row = await getTrackRow(db, trackId);
  if (!row) return { ok: false, error: `track not found: ${trackId}` };

  const fileRows = await db.select().from(files).where(eq(files.id, row.fileId)).limit(1);
  const file = fileRows[0] as FileRecord | undefined;
  if (!file) return { ok: false, error: `file not found: ${row.fileId}` };
  if (!file.pieceId) return { ok: false, error: "track file has no piece" };

  const track = await readTrack(file.pieceId, trackId);
  if (!track) return { ok: false, error: `track sidecar not found: ${trackId}` };

  const inRange = (t: number) => t >= range.start && t <= range.end;
  const anchors = [
    ...(track.manualAnchors ?? []).filter((m) => inRange(m.time)),
    ...(track.agentAnchors ?? []).filter((a) => inRange(a.time)),
  ].map((a) => ({
    fileId: file.id,
    time: a.time,
    bbox: a.bbox as [number, number, number, number],
  }));

  return { ok: true, file, pieceId: file.pieceId, anchors };
}

/** Delegate the identity-candidates engine run to the Next.js server EXACTLY
 *  like `groundCandidates` delegates the Stage-0 grounding run. The MCP child
 *  never imports `lib/jobs/*`; the engine runs server-side under JobManager. */
async function fetchIdentityCandidates(
  file: FileRecord,
  pieceId: string,
  range: { start: number; end: number },
  anchors: { fileId: string; time: number; bbox: [number, number, number, number] }[],
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<IdentityCandidate[]> {
  const resp = await runJobViaServer<{ candidateTracklets?: IdentityCandidate[] }>(
    "tracking",
    {
      fileId: file.id,
      pieceId,
      fileUrl: fileUrlFor(file.id),
      fps: 30,
      objectKind: "object",
      method: "candidates",
      range,
      classes: ["person"],
      anchors,
    },
    { extra, resume: true, pieceId, fileId: file.id },
  );
  const r = legacyTripleFromRunJobResult(resp);
  return sortCandidatesBySim(r.result.candidateTracklets ?? []);
}

export async function listIdentityCandidates(
  params: ListIdentityCandidatesParams,
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<
  ToolResult<
    {
      ambiguous: boolean;
      candidates: { candidateId: number; meanTargetSim: number | null; frameCount: number }[];
      frames?: { time: number; pngBase64: string }[];
    },
    { hint: string } | { jobId: string }
  >
> {
  const db = getDb();
  const resolved = await resolveTrackForCandidates(db, params.trackId, params.range);
  if (!resolved.ok) return { success: false, error: resolved.error };

  let cands: IdentityCandidate[];
  try {
    cands = await fetchIdentityCandidates(
      resolved.file,
      resolved.pieceId,
      params.range,
      resolved.anchors,
      extra,
    );
  } catch (err) {
    if (err instanceof LibiServerUnavailableError) {
      return { success: false, error: "libi_server_unavailable", data: { hint: err.hint } };
    }
    if (err instanceof CancelledError) {
      return { success: false, error: "cancelled", data: { jobId: err.jobId } };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (cands.length === 0) {
    return { success: true, data: { ambiguous: false, candidates: [] } };
  }

  let frames: { time: number; pngBase64: string }[] = [];
  try {
    const res = await fetch(
      `http://127.0.0.1:${getCurrentPort()}/api/tracking/identity-candidates-render`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pieceId: resolved.pieceId,
          fileId: resolved.file.id,
          candidates: cands,
          range: params.range,
        }),
      },
    );
    const json = (await res.json()) as {
      success: boolean;
      error?: string;
      frames?: { time: number; pngBase64: string }[];
    };
    if (res.ok && json.success) {
      frames = json.frames ?? [];
    } else {
      logger.warn(
        {
          tag: "tracking-verify",
          op: "identity_candidates_render.fail",
          err: json.error ?? `HTTP ${res.status}`,
        },
        "identity-candidates render route failed",
      );
    }
  } catch (e) {
    logger.warn(
      {
        tag: "tracking-verify",
        op: "identity_candidates_render.fail",
        err: e instanceof Error ? e.message : String(e),
      },
      "identity-candidates render route unreachable",
    );
  }

  return {
    success: true,
    data: {
      ambiguous: true,
      candidates: cands.map((c) => ({
        candidateId: c.candidateId,
        meanTargetSim: c.meanTargetSim,
        frameCount: c.frameCount,
      })),
      frames,
    },
  };
}

export async function pickCandidate(
  params: PickCandidateParams & {
    /** Test seam: injected DB (mirrors apply-segment-result.test.ts harness). */
    _db?: AnyDb;
    /** Test seam: injected candidates (production fetches via runJobViaServer). */
    _candidates?: IdentityCandidate[];
  },
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<
  ToolResult<
    { trackId: string; segmentId: string; summary: ReturnType<typeof summarizeTrack> },
    { hint: string } | { jobId: string }
  >
> {
  const db = params._db ?? getDb();
  const resolved = await resolveTrackForCandidates(db, params.trackId, params.range);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const { file, pieceId } = resolved;

  let cands: IdentityCandidate[];
  if (params._candidates) {
    cands = sortCandidatesBySim(params._candidates);
  } else {
    try {
      cands = await fetchIdentityCandidates(file, pieceId, params.range, resolved.anchors, extra);
    } catch (err) {
      if (err instanceof LibiServerUnavailableError) {
        return { success: false, error: "libi_server_unavailable", data: { hint: err.hint } };
      }
      if (err instanceof CancelledError) {
        return { success: false, error: "cancelled", data: { jobId: err.jobId } };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const chosen = cands.find((c) => c.candidateId === params.candidateId);
  if (!chosen) {
    return {
      success: false,
      error: `candidate not found: ${params.candidateId} (available: ${cands
        .map((c) => c.candidateId)
        .join(", ")})`,
    };
  }

  // Map the picked tracklet's perFrame boxes → authoritative TrackSample[].
  const samples: TrackSample[] = chosen.perFrame.map((pf) => ({
    t: pf.t,
    x: pf.bbox[0],
    y: pf.bbox[1],
    w: pf.bbox[2],
    h: pf.bbox[3],
    confidence: 1,
    visible: true,
  }));

  // Pick up the nearest OK segment's objectKind so a face-track pick stays a
  // face segment (mixedBoxSemantics guard). Default "object".
  const track = await readTrack(pieceId, params.trackId);
  const center = (params.range.start + params.range.end) / 2;
  const okSegs = (track?.segments ?? []).filter((s) => s.status === "ok");
  let objectKind: "face" | "object" = "object";
  if (okSegs.length > 0) {
    const nearest = okSegs.reduce((best, s) => {
      const sMid = (s.startTime + s.endTime) / 2;
      const bMid = (best.startTime + best.endTime) / 2;
      return Math.abs(sMid - center) < Math.abs(bMid - center) ? s : best;
    }, okSegs[0]);
    objectKind = nearest.objectKind ?? "object";
  }

  const framerate = track?.framerate || 30;

  // NEVER MAKE WORSE: every perFrame point is mapped to visible:true below, so
  // this is effectively an empty-perFrame check (it is NOT computeTrackSegment's
  // post-engine anyVisible guard — there `visible` can genuinely be false). If
  // the picked candidate has no frames, do NOT upsert a "lost"
  // provenance:"agent" segment over params.range: deriveSamples (agent wins)
  // would FILTER the prior engine samples in that window and concat nothing,
  // blanking it (strictly worse than before). The user explicitly picked this
  // candidate, so fail loud (hard error) and let them re-pick rather than
  // silently blanking the prior good samples.
  if (!samples.some((s) => s.visible)) {
    return {
      success: false,
      error: `candidate ${params.candidateId} has no usable frames in [${params.range.start},${params.range.end}] — not overwriting prior samples`,
    };
  }

  let applied: { trackId: string; segmentId: string; summary: ReturnType<typeof summarizeTrack> };
  try {
    applied = await applySegmentResult({
      db,
      file: {
        id: file.id,
        pieceId,
        mediaWidth: file.mediaWidth,
        mediaHeight: file.mediaHeight,
        mediaDuration: file.mediaDuration,
      },
      trackId: params.trackId,
      range: params.range,
      method: "yoloe+botsort",
      objectKind,
      provenance: "agent",
      out: { samples, framerate },
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Record the pick in the same agentAnchors channel computeTrackSegment uses
  // (deterministic agt-<ms> ids via agentAnchorId/upsertAgentAnchor) so a later
  // recompute re-seeds from the picked subject. computeTrackSegment persists the
  // few anchors the agent supplied as-is (no sparsifier — they're just few); we
  // must derive a SPARSE set ourselves because chosen.perFrame is at video fps
  // (a per-frame write would persist ~150 anchors for a 5s window and
  // over-constrain every later re-track). The ≤8-evenly-spaced policy here
  // mirrors refineTrackWithSam2 (tracking-tools.ts ~lines 1045-1048) — the
  // codebase's existing sparse-anchor convention.
  const cur = await readTrack(pieceId, params.trackId);
  if (cur) {
    let agentAnchors = cur.agentAnchors ?? [];
    const MAX_ANCHORS = 8;
    const pts = chosen.perFrame;
    const step = Math.max(1, Math.floor(pts.length / MAX_ANCHORS));
    const sparse = pts.filter((_, i) => i % step === 0).slice(0, MAX_ANCHORS);
    for (const pf of sparse) {
      agentAnchors = upsertAgentAnchor(agentAnchors, {
        id: agentAnchorId(pf.t),
        time: pf.t,
        bbox: pf.bbox,
      });
    }
    await writeTrack(pieceId, { ...cur, agentAnchors });
  }

  logger.info(
    {
      tag: "tracking-compute",
      op: "tracking.pick_candidate.done",
      trackId: params.trackId,
      segmentId: applied.segmentId,
      candidateId: params.candidateId,
      sampleCount: samples.length,
    },
    "pick_candidate wrote authoritative agent segment",
  );

  return {
    success: true,
    data: { trackId: applied.trackId, segmentId: applied.segmentId, summary: applied.summary },
  };
}

// ---------------------------------------------------------------------------
// verify_tracked_overlay — render spot-check frames via Next.js route
// ---------------------------------------------------------------------------

interface VerifyFramePayload {
  time: number;
  pngBase64?: string;
  error?: string;
  segmentId: string | null;
  method: string | null;
  status: string | null;
  objectKind: string | null;
  isAnchorFrame: boolean;
  sampledRect: { x: number; y: number; w: number; h: number } | null;
  trackBbox: { x: number; y: number; w: number; h: number } | null;
  visible: boolean;
}

export async function verifyTrackedOverlay(
  params: VerifyTrackedOverlayParams,
): Promise<
  ToolResult<
    {
      frames: VerifyFramePayload[];
      summary: unknown;
      segments: unknown[];
      truncated: boolean;
      coveredIssueRanges: { start: number; end: number }[];
      persistedFileIds: Record<string, string>;
    },
    { hint: string }
  >
> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${getCurrentPort()}/api/tracking/verify-render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch {
    return {
      success: false,
      error: "libi_server_unavailable",
      data: { hint: "Start libi (the Next.js server) before verifying a tracked overlay." },
    };
  }

  let json: { success: boolean; error?: string } & Record<string, unknown>;
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return { success: false, error: `verify route returned non-JSON (HTTP ${res.status})` };
  }

  if (!res.ok || !json.success) {
    return { success: false, error: json.error ?? `verify route failed (HTTP ${res.status})` };
  }
  return {
    success: true,
    data: {
      frames: json.frames as VerifyFramePayload[],
      summary: json.summary,
      segments: (json.segments ?? []) as unknown[],
      truncated: !!json.truncated,
      coveredIssueRanges: (json.coveredIssueRanges ?? []) as { start: number; end: number }[],
      persistedFileIds: (json.persistedFileIds ?? {}) as Record<string, string>,
    },
  };
}

// ---------------------------------------------------------------------------
// verify_install — check tracking engine install status via Next.js endpoint
// ---------------------------------------------------------------------------

export async function verifyInstall(
  _params: VerifyInstallParams,
): Promise<
  ToolResult<{ ok: boolean; installed: boolean; missing: string[]; versions: Record<string, string> }>
> {
  let port: number;
  try {
    port = getCurrentPort();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: "libi_server_unavailable",
      data: {
        hint: `libi server not running (port file missing: ${msg}). Start it with \`npx @nagellabs/libi\` or \`npx @nagellabs/libi --connect-agent\`.`,
      } as unknown as never,
    };
  }

  const url = `http://127.0.0.1:${port}/api/tracking/verify`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: "libi_server_unavailable",
      data: {
        hint: `Could not reach libi server at port ${port}: ${msg}. Start it with \`npx @nagellabs/libi\` or \`npx @nagellabs/libi --connect-agent\`.`,
      } as unknown as never,
    };
  }

  if (!res.ok) {
    return { success: false, error: `verify endpoint returned HTTP ${res.status}` };
  }

  let body: {
    ok: boolean;
    installed: boolean;
    missing: string[];
    versions: Record<string, string>;
    error?: string;
  };
  try {
    body = await res.json();
  } catch (err) {
    // A 200 with a non-JSON body (HTML error page, proxy interstitial,
    // truncated stream) must surface as a structured error — an MCP tool
    // must never throw out to the agent.
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `verify endpoint returned non-JSON body: ${msg}` };
  }
  return { success: true, data: { ok: body.ok, installed: body.installed, missing: body.missing, versions: body.versions } };
}

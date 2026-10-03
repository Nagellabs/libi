/**
 * The tracking family: `libi.track` (the track itself: compute, repair, list, delete) and
 * `libi.tracked_overlay` (pin an overlay to a track and spot-check it).
 *
 * Registered by `registerTrackingTools` (mcp/tracking-mcp/register-tracking-tools.ts), the ONE shared
 * registration of the tracking surface, so the core server and the standalone `libi serve-mcp-tracking`
 * cannot drift. `install_tracking_engine` and `remove_background` stay separate tools.
 *
 * Both names fall under the libi-tracking extension's `toolPrefixes` (`libi.track`, `libi.tracked_overlay`),
 * exactly as the per-verb names did.
 */
import { z } from "zod/v3";
import * as tools from "@/mcp/tools";
import {
  ComputeObjectTrackShape,
  AddTrackedOverlaySchema,
  UpdateTrackedOverlaySchema,
  DeleteTrackSchema,
  ListTracksSchema,
  UpdateTrackResultSchema,
  ComputeTrackSegmentSchema,
  SkipSegmentSchema,
  ListTrackSegmentsSchema,
  GroundTargetSchema,
  VerifyTrackedOverlayShape,
  ListIdentityCandidatesSchema,
  PickCandidateSchema,
} from "@/mcp/tools/schemas";
import { notify } from "@/mcp/notify";
import { action, type ActionToolDef, type WireToolResult } from "@/mcp/tools/action-tool";

type McpBlock = WireToolResult["content"][number];

/** A result carrying images (the verify frames, the identity candidates): each frame's PNG becomes an
 *  image block and the text block keeps everything else, with `hasImage` in place of the bytes. */
export function buildVerifyContent(result: tools.AnyToolResult): WireToolResult {
  if (!result.success) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: result.error }) }],
      isError: true,
    };
  }
  const data = (result.data ?? {}) as {
    frames?: { pngBase64?: string }[];
  } & Record<string, unknown>;
  const frames = data.frames ?? [];
  const blocks: McpBlock[] = [];
  for (const f of frames) {
    if (f.pngBase64) blocks.push({ type: "image", data: f.pngBase64, mimeType: "image/png" });
  }
  const lean = {
    ...data,
    frames: frames.map((f) => {
      const { pngBase64, ...rest } = f;
      return { ...rest, hasImage: !!pngBase64 };
    }),
  };
  blocks.push({ type: "text", text: JSON.stringify({ success: true, data: lean }) });
  return { content: blocks };
}

const SKILL_FIRST =
  "Load the `using-object-tracking` skill first and follow it (anchors, verification, the repair loop).";

export const trackTool: ActionToolDef = {
  name: "libi.track",
  description:
    `Track a moving subject (face, person, object) across a video and repair the track: compute, recompute or skip a bad window, ground a target, resolve look-alikes, list/delete, import outside samples. Local, free. ${SKILL_FIRST} Pin an overlay with libi.tracked_overlay. Actions: compute, compute_segment, list, list_segments, delete, update_result, skip_segment, ground_target, list_candidates, pick_candidate.`,
  // Typed differently per action: advertise the loosest form, each action still enforces its own.
  widen: {
    anchors: z.array(z.record(z.unknown())),
    method: z.string().min(1),
    samples: z.array(z.record(z.unknown())).min(1),
  },
  props: {
    fileId: "Source video file id.",
    trackId: "Track id. Optional for compute_segment (omit to start a track) and update_result (replaces that track); required by the rest.",
    objectKind: "'face' (the head region, stable through dance and raised arms) or 'object'. Required for compute; compute_segment defaults to 'object'.",
    anchors:
      "Reference boxes [{ fileId, time, bbox: [x, y, w, h] }] in source-frame pixels, up to 100; manual anchors win within 0.1s. compute: optional with derivedFrom*Name; compute_segment: 1-100 required; update_result: the external tracker's anchors.",
    range: "{ start, end } seconds, end > start: the window to recompute, skip or disambiguate.",
    method: "compute_segment: 'yoloe+botsort' | 'yoloe-text' | 'sot'. update_result: a free-form tracker id (e.g. 'external-mcp:my-tracker').",
    classes: "Target class(es), default ['person']; a non-person class (e.g. ['backpack']) routes to the YOLOE-VP detector. ground_target: the classes to detect.",
    forceNew: "Ignore any cached or partial result and recompute (default reuses matching segments and resumes an interrupted run).",
    derivedFromSubjectName: "Derive anchors from analyzed keyframes with a person of this name (needs analysis with people[].bbox).",
    derivedFromItemName: "Derive anchors from analyzed keyframes with an object of this name (needs analysis with objects[].bbox).",
    subjectQuery: "Log hint only; does NOT disambiguate detections (anchors do).",
    time: "Seconds at which to detect candidate objects.",
    samples: "Per-frame samples in pixels, like libi's TrackSample: { t, x, y, w, h, confidence? (0-1, default 1), visible, subjectId? }.",
  },
  actions: {
    compute: action({
      describe:
        "the DEFAULT tracker: the whole clip, one segment per shot (recompute a bad window with compute_segment). Returns { trackId, segments[], summary { perSegment, visibleRanges, lostRanges, flags } } for libi.tracked_overlay add",
      schema: ComputeObjectTrackShape,
      run: (params, extra) => tools.computeObjectTrack(params, extra as never),
    }),
    compute_segment: action({
      describe:
        "the REPAIR step: compute or replace ONE time-range segment with a chosen method, leaving the others untouched; returns the segment's quality summary",
      schema: ComputeTrackSegmentSchema,
      run: (params, extra) => tools.computeTrackSegment(params, extra as never),
    }),
    list: action({
      describe: "tracks computed for a file",
      schema: ListTracksSchema,
      run: (params) => tools.listTracks(params),
    }),
    list_segments: action({
      describe: "a track's segments with status (ok | lost | skipped), visible/total counts, reason",
      schema: ListTrackSegmentsSchema,
      run: (params) => tools.listTrackSegments(params),
    }),
    delete: action({
      describe:
        "delete a track; tracked overlays that use it fail to render until updated or removed",
      schema: DeleteTrackSchema,
      run: async (params) => {
        const result = await tools.deleteTrack(params);
        if (result.success && result.data?.pieceId) {
          notify.refreshQuery({ queryKey: "composition", pieceId: result.data.pieceId });
        }
        return result;
      },
    }),
    update_result: action({
      describe:
        "store samples tracked OUTSIDE libi; returns a trackId for libi.tracked_overlay add (replace-only: the same trackId twice discards the prior samples)",
      schema: UpdateTrackResultSchema,
      run: (params) => tools.updateTrackResult(params),
    }),
    skip_segment: action({
      describe:
        "mark a range as intentionally untracked (subject not visible): renders nothing there; prefer it to a bad track",
      schema: SkipSegmentSchema,
      run: (params) => tools.skipSegment(params),
    }),
    ground_target: action({
      describe:
        "detect candidate objects at a timestamp and return NUMBERED boxes: LOOK at the frame, pick the user's target and pass that bbox as the anchor to compute / compute_segment; never hand-guess pixel coordinates",
      schema: GroundTargetSchema,
      run: (params, extra) => tools.groundTarget(params, extra as never),
    }),
    list_candidates: action({
      describe:
        "for a window with look-alike subjects: candidate tracklets as colored frames { ambiguous, candidates: [{ candidateId, meanTargetSim, frameCount }], frames }; LOOK, then pick_candidate",
      schema: ListIdentityCandidatesSchema,
      run: async (params, extra) => buildVerifyContent(await tools.listIdentityCandidates(params, extra as never)),
    }),
    pick_candidate: action({
      describe:
        "lock a list_candidates pick (`candidateId`) as an authoritative segment for its window (beats the engine, not a user's manual drag); later recomputes re-seed from it; then libi.tracked_overlay verify",
      schema: PickCandidateSchema,
      run: (params, extra) => tools.pickCandidate(params, extra as never),
    }),
  },
};

const TRACKED_CONTENT = z.object({ kind: z.enum(["emoji", "text", "image", "video", "code", "effect"]) }).passthrough();

export const trackedOverlayTool: ActionToolDef = {
  name: "libi.tracked_overlay",
  description:
    `Pin an overlay (emoji, text, image, video, drawn code, blur / pixelate / mask) to a moving subject using a track from libi.track, change it, or visually spot-check it. ${SKILL_FIRST} Actions: add, update, verify.`,
  widen: {
    content: TRACKED_CONTENT,
    // The strictest bound belongs to the action that has one (add/update: scale <= 5; add/update: maxBoxScale 1..4).
    scale: z.number().positive(),
    maxBoxScale: z.number().positive(),
  },
  props: {
    content:
      "What follows the subject: { kind:'emoji', char } | { kind:'text', content, font, color, align } | { kind:'image', fileId } | { kind:'video', fileId, trim?: { start, end } } | { kind:'code', drawFunction } | { kind:'effect', op:'blur'|'pixelate'|'mask' } (per-kind fields: the using-object-tracking skill).",
    fit: "Box to overlay size: 'tight' = the face box, 'head' = extended upward for the full head, 'rect' = the overlay's own rect size centered on the box.",
    scale: "Multiplier on `fit` (1.0 = box-tight; 1.2-1.4 typical for an emoji on a face), up to 5.",
    maxBoxScale: "Max factor a frame's box may exceed the track's median size before it is clamped (lower = stricter; sizeMode 'stabilized' only). Default 1.75, 1 to 4.",
    positionMode: "'stabilized' (default) smooths the box CENTER against tracker jitter; 'raw' follows samples verbatim (a deliberately bouncy look). Never change `smoothing` to fix jitter.",
    offset: "Follow offset in box fractions, e.g. {x:0,y:-1} = one box-height above the head; the track is never modified; {x:0,y:0} clears it.",
    trackId: "A track id from libi.track.",
    fileId: "verify, before attaching: the source video file id.",
    pieceId: "The piece holding the overlay.",
    overlayId: "The tracked overlay to update, or to verify after attaching.",
    startTime: "Seconds on the piece timeline where the overlay starts.",
    duration: "Seconds the overlay lasts.",
  },
  actions: {
    add: action({
      describe:
        "pin an overlay to a subject (needs a trackId from libi.track compute); a flagged track is refused unless you inspected summary.issues and pass `acknowledgeQualityIssues: true`",
      schema: AddTrackedOverlaySchema,
      run: async (params) => {
        const result = await tools.addTrackedOverlay(params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return result;
      },
    }),
    update: action({
      describe:
        "change any field of a tracked overlay (track, content, timing, rect, z, opacity, fit, scale, smoothing); only passed fields change. For bounce use positionMode, not `smoothing` (sub-frame interpolation, not a denoiser)",
      schema: UpdateTrackedOverlaySchema,
      run: async (params) => {
        const result = await tools.updateTrackedOverlay(params);
        if (result.success) notify.refreshQuery({ queryKey: "composition", pieceId: params.pieceId });
        return result;
      },
    }),
    verify: action({
      describe:
        "read-only: renders the overlay on the footage at the frames most likely to be wrong (issue/lost/flagged ranges, the final seconds) and returns images with tracking context. LOOK; fix a bad window with libi.track compute_segment / skip_segment, then verify again. BEFORE attaching pass { fileId, trackId, content, fit } (+ offset / sizeMode / maxBoxScale / positionMode); AFTER attaching pass { pieceId, overlayId }. Never re-tracks or writes the track",
      schema: VerifyTrackedOverlayShape,
      run: async (params) => buildVerifyContent(await tools.verifyTrackedOverlay(params as never)),
    }),
  },
};

export const TRACKING_MERGED_TOOLS: readonly ActionToolDef[] = [trackTool, trackedOverlayTool];

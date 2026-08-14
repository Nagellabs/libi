import type { Track, TrackSample } from "@/lib/tracking/types";

/** Appearance-gate cosine floor. MUST equal the Python sidecar's
 *  pipeline.py TAU — both are pinned together by the B+C plan Task 9. */
export const APPEARANCE_TAU = 0.78;

export interface Range { start: number; end: number; }

/** A concrete, actionable quality problem in a track, with the time
 *  window it occurs in so the agent can target `compute_track_segment`
 *  / `skip_segment` at exactly that range instead of guessing. */
export interface TrackIssue {
  kind: string;
  range: Range;
  detail: string;
}

export interface SegmentSummary {
  id: string;
  startTime: number;
  endTime: number;
  method: string;
  status: string;
  visible: number;
  total: number;
}

export interface TrackSummary {
  total: number;
  visible: number;
  visibleRanges: Range[];
  lostRanges: Range[];
  /** Unique issue kinds (back-compat: was always a string[]). */
  flags: string[];
  /** Structured, range-tagged issues — what to actually go fix. */
  issues: TrackIssue[];
  perSegment: SegmentSummary[];
}

function ranges(samples: TrackSample[], pred: (s: TrackSample) => boolean): Range[] {
  const r: Range[] = [];
  let cur: Range | null = null;
  for (const s of samples) {
    if (pred(s)) {
      if (!cur) cur = { start: s.t, end: s.t };
      else cur.end = s.t;
    } else if (cur) { r.push(cur); cur = null; }
  }
  if (cur) r.push(cur);
  return r;
}

function center(s: TrackSample) {
  return { cx: s.x + s.w / 2, cy: s.y + s.h / 2 };
}

function iou(a: TrackSample, b: TrackSample): number {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/**
 * Build the per-track quality report. Beyond raw visible/lost ranges this
 * now actively detects the failure modes that silently produced a
 * "1152/1152 visible, flags:[]" report for a track that was on the wrong
 * subject for 16s:
 *
 *  - `oversized_box_while_visible` — the box is far bigger than a real
 *    subject (a noisy detection); this is what makes an overlay briefly
 *    balloon to fill the frame.
 *  - `identity_switch_suspected` — the box teleports to a disjoint region
 *    (IoU≈0, large centroid jump) and stays there: the tracker latched
 *    onto a different subject (e.g. a cameraman).
 *  - `edge_pinned` — a long run hugging a frame edge with a tall/narrow
 *    box: the classic "followed a background person" signature.
 *
 * Every issue carries the time `range` so the agent can repair exactly
 * that window via `compute_track_segment` / `skip_segment`.
 */
export function summarizeTrack(
  track: Track,
  opts: { frameW: number; frameH: number; clipDurationSec: number },
): TrackSummary {
  const samples = track.samples ?? [];
  const flags: string[] = [];
  const issues: TrackIssue[] = [];
  const W = opts.frameW, H = opts.frameH;
  const fullArea = 0.9 * W * H;
  const isFullCanvas = (s: TrackSample) => s.visible && s.w * s.h >= fullArea;
  if (samples.some(isFullCanvas)) {
    flags.push("full_canvas_while_visible");
  }
  if (samples.some((s) => s.t > opts.clipDurationSec + 0.05)) {
    flags.push("samples_exceed_clip_duration");
  }

  const isFull = (s: TrackSample) => isFullCanvas(s);
  const effectivelyVisible = (s: TrackSample) => s.visible && !isFull(s);
  const normalSamples = samples.filter((s) => !isFull(s));

  // ── oversized_box_while_visible ────────────────────────────────────
  // A real subject rarely exceeds ~80% of a frame dimension or ~55% of
  // frame area. Boxes that do are bad detections — they make a fitted
  // overlay balloon for those frames.
  //
  // …UNLESS an anchor says otherwise. These thresholds mirror
  // `_is_degenerate_box` in mcp/tracking/py/libitrack/pipeline.py, and that
  // guard learned (2026-08-02) to compare an ANCHOR-BOUND candidate against
  // the anchor instead of the frame: a legitimate close-up — talking head,
  // interview, UGC selfie, product macro — routinely exceeds 82% of frame
  // height, and refusing those produced `no_output` on perfectly good footage.
  //
  // Fixing only the engine made the two disagree: the engine correctly bound a
  // 639x656 anchored astronaut in a 1280x720 frame at 100% visible, and this
  // summary then flagged EVERY frame of that correct track as oversized —
  // which `add_tracked_overlay` treats as blocking. A false alarm on a
  // 100%-correct track is worse than no alarm: it trains the agent to pass
  // `acknowledgeQualityIssues` reflexively, which is the whole point of the
  // honest-output gate.
  //
  // So when the track's own anchors are themselves "oversized" by the absolute
  // rule, the user/agent deliberately pointed at a big subject, and the
  // question becomes the engine's: has the box BALLOONED away from what was
  // pointed at? Tracks with no anchors, or with normal-sized ones, keep the
  // absolute rule byte-for-byte.
  // NB the trigger is the anchor tripping the SAME rule — the real astronaut
  // anchor (639x656 in 1280x720) trips the HEIGHT arm while its area is only
  // 45% of frame, so an area-only test here would silently change nothing.
  //
  // ── The relaxation is PER-ARM, per-sample, against the NEAREST-IN-TIME
  //    anchor over the UNION of all three anchor channels, each arm CAPPED ──
  //
  // The first version collapsed all three arms into ONE area test licensed by
  // the largest anchor anywhere in the track, and that gave away far more than
  // the astronaut case needed:
  //
  //   * IT DROPPED THE W/H ARMS. This is the mechanism, and it is what lets a
  //     genuinely bad box through. The astronaut anchor (639x656 in 1280x720)
  //     trips the HEIGHT arm only — its width is well under 0.82·W and its
  //     area is 45% of frame, under the 0.55 arm. But the relaxation replaced
  //     every arm with `area > 1.6 × anchorArea = 670,694`, so a 1100x580
  //     wrong-subject balloon — 86% of frame WIDTH, and over the area arm too
  //     — measured 638,000 and sailed through. Nothing about a tall anchor
  //     says a frame-wide box is now acceptable.
  //   * NEVER-FIRES. Any anchor at or above 0.5625·W·H pushed the licensed
  //     area past the 0.9·W·H full-canvas cutoff, so the flag became
  //     mathematically unable to fire and the whole 55–90% band went
  //     unmonitored. `identity_switch_suspected` does not cover that: it needs
  //     ReID data, and a balloon that still CONTAINS the subject keeps
  //     appearance similarity high.
  //   * ANCHORS ONLY. `track.anchors` is written once at init from the first
  //     segment, so repair anchors (`agentAnchors`), user pins
  //     (`manualAnchors`) and later fan-out shots never participated — the
  //     false block this relaxation exists to prevent came straight back on
  //     the repair loop the `using-object-tracking` skill teaches. The
  //     identity-switch section right below already reads all three channels,
  //     which is what marks this an oversight rather than a decision.
  //
  // So: an anchor licenses ONLY the dimension it itself exceeds, only up to
  // its own size times the balloon ratio, and never past a hard cap. Every
  // other arm keeps its absolute threshold byte-for-byte.
  //
  // On time scoping: nearest-in-time is what the multi-anchor case needs, and
  // it is deliberately NOT the engine's ±2-frame window — the astronaut
  // track's anchors are sparse, and that window would flag most of a correct
  // track. Be clear-eyed about the consequence: with a SINGLE anchor,
  // "nearest" is every sample, so time locality does no work there and the
  // per-arm limits above are the entire defence. That is why the arms, not the
  // scoping, are the load-bearing part of this fix.
  const ABS_W = 0.82 * W;
  const ABS_H = 0.82 * H;
  const ABS_AREA = 0.55 * W * H;
  const boxOversized = (w: number, h: number) =>
    w >= ABS_W || h >= ABS_H || w * h >= ABS_AREA;

  const allAnchors = [
    ...(track.anchors ?? []),
    ...(track.manualAnchors ?? []),
    ...(track.agentAnchors ?? []),
  ]
    .map((a) => ({ t: a.time, w: a.bbox?.[2] ?? 0, h: a.bbox?.[3] ?? 0 }))
    .filter((b) => b.w > 0 && b.h > 0 && Number.isFinite(b.t));

  /** Nearest anchor in time, or null when the track has none. */
  const nearestAnchor = (t: number) => {
    let best: { t: number; w: number; h: number } | null = null;
    let bestDist = Infinity;
    for (const a of allAnchors) {
      const d = Math.abs(a.t - t);
      if (d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    return best;
  };

  // Mirrors ANCHOR_BALLOON_AREA_RATIO in pipeline.py.
  const ANCHOR_BALLOON_RATIO = 1.6;
  // Caps, so no anchor can license a box the flag could never reach. The area
  // cap is set at 0.75·W·H: the astronaut anchor's own licence is 0.728·W·H,
  // so this is the loosest value the motivating case actually needs, and it
  // leaves the 0.75–0.9 band permanently monitored instead of dead.
  const CAP_W = 0.95 * W;
  const CAP_H = 0.95 * H;
  const CAP_AREA = 0.75 * W * H;

  const oversized = (s: TrackSample) => {
    if (!effectivelyVisible(s)) return false;
    const a = nearestAnchor(s.t);
    // No anchor, or a normal-sized one: the absolute rule, unchanged.
    if (!a || !boxOversized(a.w, a.h)) return boxOversized(s.w, s.h);
    const aArea = a.w * a.h;
    const wLimit = a.w >= ABS_W ? Math.min(a.w * ANCHOR_BALLOON_RATIO, CAP_W) : ABS_W;
    const hLimit = a.h >= ABS_H ? Math.min(a.h * ANCHOR_BALLOON_RATIO, CAP_H) : ABS_H;
    const areaLimit =
      aArea >= ABS_AREA ? Math.min(aArea * ANCHOR_BALLOON_RATIO, CAP_AREA) : ABS_AREA;
    return s.w >= wLimit || s.h >= hLimit || s.w * s.h >= areaLimit;
  };
  for (const r of ranges(samples, oversized)) {
    issues.push({
      kind: "oversized_box_while_visible",
      range: r,
      detail:
        "Box is far larger than a typical subject here (likely a bad detection / wrong subject). " +
        "Re-seed this window with a tight anchor via compute_track_segment, or skip_segment if untrackable.",
    });
  }

  // ── size_jitter ────────────────────────────────────────────────────
  // RELATIVE oversize: a visible box far larger than THIS track's own
  // median area. The absolute oversized_box guard misses mid-frame
  // balloons (e.g. 5× median at 20% of frame) that still make a fitted
  // overlay flash. Advisory (not in BLOCKING_QUALITY_FLAGS) — the default
  // stabilized render tames it; the agent can lower maxBoxScale.
  const SIZE_JITTER_RATIO = 3;
  const visAreas = normalSamples
    .filter((s) => s.visible && s.w > 0 && s.h > 0)
    .map((s) => s.w * s.h)
    .sort((a, b) => a - b);
  if (visAreas.length >= 8) {
    const medArea = visAreas[Math.floor(visAreas.length / 2)];
    const jitter = (s: TrackSample) =>
      effectivelyVisible(s) && s.w * s.h >= SIZE_JITTER_RATIO * medArea;
    for (const r of ranges(samples, jitter)) {
      issues.push({
        kind: "size_jitter",
        range: r,
        detail:
          "Box is far larger than this track's typical size here, so the overlay balloons/flashes. " +
          "This is a SIZE problem, not position: keep sizeMode:'stabilized' (default) or lower maxBoxScale " +
          "via update_tracked_overlay. Only re-anchor if the box is a grossly wrong detection.",
      });
    }
  }

  // ── edge_pinned ────────────────────────────────────────────────────
  // A long run hugging a vertical frame edge with a tall, narrow box is
  // the classic "tracker latched onto a background person/cameraman".
  const EDGE_MIN_SEC = 1.5;
  const edgePinned = (s: TrackSample) =>
    effectivelyVisible(s) &&
    (s.x <= 0.02 * W || s.x + s.w >= 0.98 * W) &&
    s.h > 1.4 * s.w;
  for (const r of ranges(samples, edgePinned)) {
    if (r.end - r.start >= EDGE_MIN_SEC) {
      issues.push({
        kind: "edge_pinned",
        range: r,
        detail:
          "Box stuck to a frame edge for a sustained period — usually a background person/cameraman, " +
          "not the intended subject. Re-anchor this window (ground_target + compute_track_segment) or skip_segment.",
      });
    }
  }

  // ── identity_switch_suspected ──────────────────────────────────────
  // PRIMARY (appearance): a sustained run where the bound box stopped
  // resembling the anchored subject (targetSim < TAU) — the tracker is on
  // a DIFFERENT subject even if it didn't teleport. FALLBACK (geometric):
  // when the track has no targetSim signal at all (legacy / no-ReID),
  // keep the old teleport-and-stay heuristic.
  const hasAppearance = samples.some((s) => s.targetSim != null);
  if (hasAppearance) {
    const SWITCH_SIM = APPEARANCE_TAU;
    const MIN_SWITCH_SEC = 0.5;
    const ANCHOR_EPS = 0.05;
    const anchorTimes = [
      ...(track.manualAnchors ?? []).map((a) => a.time),
      ...(track.agentAnchors ?? []).map((a) => a.time),
    ];
    const lowSim = (s: TrackSample) =>
      effectivelyVisible(s) &&
      s.targetSim != null &&
      s.targetSim < SWITCH_SIM;
    for (const r of ranges(samples, lowSim)) {
      if (r.end - r.start < MIN_SWITCH_SEC) continue;
      const anchorAsserts = anchorTimes.some(
        (t) => t >= r.start - ANCHOR_EPS && t <= r.end + ANCHOR_EPS,
      );
      if (anchorAsserts) {
        issues.push({
          kind: "appearance_unverified_occlusion",
          range: r,
          detail:
            "Low appearance similarity here, but an explicit anchor asserts " +
            "this IS the subject (e.g. back-to-camera / occlusion). The " +
            "overlay is correctly held on the anchored subject; appearance " +
            "just can't confirm it. Non-blocking — leave it, do NOT re-anchor.",
        });
        // keep scanning: a later UNCOVERED run must still flag a real switch
        continue;
      }
      issues.push({
        kind: "identity_switch_suspected",
        range: r,
        detail:
          "Tracked box no longer resembles the anchored subject here — the tracker is on a " +
          "DIFFERENT subject. Re-anchor this exact window: ground_target (or the analysis bbox) " +
          "→ compute_track_segment({ trackId, range, method:'yoloe+botsort', anchors:[…] }). " +
          "Do NOT skip_segment — skipping hides a wrong-subject lock and the overlay still " +
          "renders the wrong subject around it.",
      });
      break; // first sustained real switch is enough to drive the repair loop
    }
  } else {
    const vis = normalSamples.filter((s) => s.visible);
    const minDim = Math.min(W, H);
    const PERSIST_SEC = 1.0;
    for (let i = 1; i < vis.length; i++) {
      const a = vis[i - 1], b = vis[i];
      if (b.t - a.t > 0.5) continue; // gap — not a continuous switch
      const ca = center(a), cb = center(b);
      const dist = Math.hypot(cb.cx - ca.cx, cb.cy - ca.cy);
      if (iou(a, b) < 0.1 && dist > 0.25 * minDim) {
        let stayedAway = true;
        for (let j = i; j < vis.length && vis[j].t - b.t <= PERSIST_SEC; j++) {
          const cj = center(vis[j]);
          if (Math.hypot(cj.cx - ca.cx, cj.cy - ca.cy) < 0.15 * minDim) {
            stayedAway = false;
            break;
          }
        }
        if (stayedAway) {
          issues.push({
            kind: "identity_switch_suspected",
            range: { start: a.t, end: b.t },
            detail:
              "Tracked box teleported to a disjoint region and stayed there — the tracker likely switched " +
              "to a different subject. Re-anchor from this time onward (ground_target + compute_track_segment " +
              "over [switch, end]) or skip_segment if the real subject is gone.",
          });
          break;
        }
      }
    }
  }

  // ── no_output ──────────────────────────────────────────────────────
  // The most extreme silent failure: the engine produced NO visible sample
  // at all (an empty track, or samples that are all absent/degenerate). This
  // is an ENGINE MISS, not a subject-absent nuance — it is the exact hole the
  // portrait "seven empty tracks" bug fell through (summarizeTrack returned
  // total:0 with flags:[]). Distinct + BLOCKING so add_tracked_overlay refuses
  // it and computeObjectTrack surfaces it. The low_visibility block below is
  // division-based and skips samples.length===0; this catches BOTH the empty
  // and the all-lost cases.
  const visCount = samples.filter(effectivelyVisible).length;
  if (samples.length === 0 || visCount === 0) {
    issues.push({
      kind: "no_output",
      range: { start: 0, end: Number.isFinite(opts.clipDurationSec) ? opts.clipDurationSec : 0 },
      detail:
        "The tracker produced NO visible samples for this track — the engine bound the subject in 0 frames. " +
        "This is an ENGINE failure, not a subject-absent window. Isolate it: run ground_target at 2-3 in-clip " +
        "timestamps; if it returns the subject at high confidence, the LOCAL engine failed on this footage — " +
        "report it to the user (or try method:'sot'). Do NOT attach an overlay to this track and do NOT " +
        "silently hand-animate a keyframe overlay as a fallback.",
    });
  }

  // ── low_visibility ─────────────────────────────────────────────────
  // A track that is effectively absent for most (but not all) of its
  // duration is NOT "clean just because no box looked wrong" — it renders
  // nothing. This closes the "127/1152 visible, flags:[]" hole. Scoped to
  // visCount > 0 so the all-absent case flags no_output (above), not both.
  const LOW_VIS_FRACTION = 0.6;
  if (samples.length > 0 && visCount > 0 && visCount / samples.length < LOW_VIS_FRACTION) {
    const lost = ranges(normalSamples, (s) => !s.visible);
    const span = lost.length
      ? { start: lost[0].start, end: lost[lost.length - 1].end }
      // defensive default — effectively unreachable: being below LOW_VIS_FRACTION implies absent samples
      // exist in normalSamples unless all invisible samples were full-canvas (covered by full_canvas_while_visible)
      : { start: 0, end: 0 };
    issues.push({
      kind: "low_visibility",
      range: span,
      detail:
        `Track is visible only ${visCount}/${samples.length} samples — it renders nothing for most of the clip. ` +
        "The subject was absent for most of the track's duration. " +
        "Re-anchor the lost windows (ground_target + compute_track_segment) or skip_segment if genuinely gone — " +
        "do NOT attach an overlay to this track as-is.",
    });
  }

  for (const it of issues) {
    if (!flags.includes(it.kind)) flags.push(it.kind);
  }

  const segs = track.segments ?? [];
  return {
    total: samples.length,
    visible: samples.filter(effectivelyVisible).length,
    visibleRanges: ranges(normalSamples, (s) => s.visible),
    lostRanges: ranges(normalSamples, (s) => !s.visible),
    flags,
    issues,
    perSegment: segs.map((seg) => ({
      id: seg.id,
      startTime: seg.startTime,
      endTime: seg.endTime,
      method: String(seg.method),
      status: seg.status,
      visible: seg.samples.filter(effectivelyVisible).length,
      total: seg.samples.length,
    })),
  };
}

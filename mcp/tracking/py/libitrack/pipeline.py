"""Segment-scoped tracking orchestrator.

Wires the verified component modules into a single per-segment run:

  1. ``detect_shots(videoPath)``           -> shot ranges (filtered to the segment)
  2. per sampled frame: ``Detector.detect`` -> ``Associator.update``
  3. ``Associator.reset()`` at every shot boundary so ids never bleed
  4. ``pick_track_for_anchor`` near an anchor's time -> bound track id
  5. emit one TrackSample dict per sampled frame (honest ``visible:false``
     when no bound track that frame)
  6. ``smooth_samples`` the full sequence
  7. emit a final ``{"type":"result", ...}`` line

stdout is RESERVED for the JSON-line protocol (progress + result). Any
diagnostic goes to stderr. The whole run is scoped to ``job["range"]`` —
emitted sample ``t`` values are always ``<= range.end``.
"""
import json
import logging
import os
import sys

import cv2

from libitrack.associate import Associator
from libitrack.bind import IOU_FLOOR_DEFAULT, pick_track_for_anchor
from libitrack.detect import Detector
from libitrack.detector_router import select_detector
from libitrack.reid_features import ReidFeatures
from libitrack.shots import detect_shots
from libitrack.smooth import smooth_samples
from libitrack.sot import SotTracker
from libitrack.headmask import head_box_from_mask
from libitrack.target import TargetTemplate

# Injectable detector factories (the router's only seam into the pipeline).
# Tests monkeypatch these; production builds the real frozen/eager backends.
# Upper-case names flag these as monkeypatching targets, not constants.
def _FROZEN_FACTORY(classes):
    return Detector(classes=classes)


def _EAGER_FACTORY(*, anchor_crop, anchor_box_xyxy, classes):
    from libitrack.detect_yoloe_vp import YoloeVpDetector

    return YoloeVpDetector(anchor_crop, anchor_box_xyxy, classes)


def _select_detector(classes, anchors, job):
    return select_detector(
        classes, anchors, job,
        frozen_factory=_FROZEN_FACTORY,
        eager_factory=_EAGER_FACTORY,
    )


def _iou_xyxy(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0

# stderr-only diagnostics — stdout is the sidecar JSON channel.
logger = logging.getLogger("libitrack.pipeline")
if not logger.handlers:
    _h = logging.StreamHandler(sys.stderr)
    _h.setFormatter(logging.Formatter("%(levelname)s libitrack.pipeline: %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)


def _emit(obj: dict) -> None:
    """Write one JSON line to stdout (the reserved protocol channel)."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _resolve_bid(binds: list, k: int):
    """Resolve the bound track id for buffered-frame index ``k``.

    Precondition: ``binds`` must already be ascending by ``buf_index``
    (``_flush_shot`` sorts it ONCE before its per-frame loop — the events
    are appended in strictly increasing ``len(shot_buf)`` order anyway, so
    this is a no-op except for defensiveness).

    ``binds`` is the shot's ``[(buf_index, id), ...]`` bind-event list.
    BoT-SORT renumbers a track across an occlusion even within ONE shot, so
    a shot can have several bind events. Per-frame resolution:

      - frames BEFORE the first bind event back-propagate the FIRST bind's
        id (preserves the pre-anchor back-prop behaviour: a single anchor
        late in the shot still recovers the earlier frames);
      - frames at/after a bind event use the MOST-RECENT bind event's id
        (greatest ``buf_index <= k``).

    With exactly one bind event for the whole shot this reduces EXACTLY to
    the old single-``bound_id`` behaviour (that one id for every frame).
    Returns ``None`` when the shot never resolved a binding.
    """
    if not binds:
        return None
    bid = binds[0][1]  # back-propagate the first bind to pre-bind frames
    for (bi, iid) in binds:
        if bi <= k:
            bid = iid
        else:
            break
    return bid


def _flush_shot(buf: list, binds: list, samples: list) -> None:
    """Flush one shot's buffered frames into ``samples`` in time order.

    BoT-SORT track ids are stable WITHIN a shot only until BoxMOT renumbers
    the subject across an occlusion (which happens even with no shot cut).
    The per-frame bound id is therefore resolved from the shot's
    ``binds`` event list via :func:`_resolve_bid` (which reduces to the old
    single-``bound_id`` behaviour when the shot has exactly one bind). For
    each buffered ``(t, tracks)`` frame we look up the resolved id in that
    frame's tracks: present -> a real ``visible:true`` sample
    (back-propagated, including pre-anchor frames); absent (or the shot
    never resolved a binding) -> the honest zeroed ``visible:false`` miss.
    This is the ONLY place sample dicts are produced for the tracking path —
    the field set / ``confidence`` convention matches the pre-buffer
    immediate-emit branch exactly.
    """
    # ``binds`` is already insertion-sorted (buf_index strictly increases as
    # events are appended), but sort ONCE here so _resolve_bid — called per
    # buffered frame below — can assume an ascending list and skip re-sorting
    # on every invocation. Behaviour is identical.
    sb = sorted(binds)
    for k, item in enumerate(buf):
        t, tracks = item[0], item[1]
        bound_id = _resolve_bid(sb, k)
        # Optional 3rd element: {track_id: head_box[x,y,w,h] | None} when
        # head-refine is on. Present → emit the silhouette-derived HEAD
        # box (robust to dance / raised arm; never the torso, never the
        # whole body); absent → the legacy person-box behaviour.
        head_by_id = item[2] if len(item) > 2 else None
        frame_sim = item[3] if len(item) > 3 else None  # Task 7 reads this
        sel = (
            next((b for (i, b) in tracks if i == bound_id), None)
            if bound_id is not None
            else None
        )
        if sel is not None:
            x1, y1, x2, y2 = sel
            if head_by_id is not None:
                hb = head_by_id.get(bound_id)
                if hb is not None:
                    hx, hy, hw, hh = (float(v) for v in hb)
                else:
                    # Mask missed this frame — fall back to the top band
                    # of the person box (still head-sized & centred, so
                    # it can never balloon to the body) for continuity.
                    bw_, bh_ = (x2 - x1), (y2 - y1)
                    hw = max(6.0, bw_ * 0.5)
                    hh = max(6.0, min(bh_ * 0.2, hw * 1.3))
                    hx = x1 + (bw_ - hw) / 2.0
                    hy = y1 + bh_ * 0.03
                samples.append(
                    {
                        "t": round(t, 4),
                        "x": hx,
                        "y": hy,
                        "w": hw,
                        "h": hh,
                        "confidence": 0.9,
                        "visible": True,
                        "targetSim": frame_sim,
                    }
                )
            else:
                samples.append(
                    {
                        "t": round(t, 4),
                        "x": x1,
                        "y": y1,
                        "w": x2 - x1,
                        "h": y2 - y1,
                        "confidence": 0.9,
                        "visible": True,
                        "targetSim": frame_sim,
                    }
                )
        else:
            # Honest miss: no bound track this frame (or unanchored shot).
            samples.append(
                {
                    "t": round(t, 4),
                    "x": 0.0,
                    "y": 0.0,
                    "w": 0.0,
                    "h": 0.0,
                    "confidence": 0.0,
                    "visible": False,
                    "targetSim": None,
                }
            )


# Re-validation uses the SAME semantic floor as initial binding
# (bind.py pick_track_for_anchor's iou_floor), so they MUST agree — they
# now share one source. A bound box overlapping a nearby anchor by LESS
# than this is not that anchor's subject.
ANCHOR_REVALIDATE_IOU = IOU_FLOOR_DEFAULT

# Anti-flap hysteresis: re-validate only when the candidate is a clearly
# better anchor match than the current box (not a lateral move to another
# weak overlap). General stability device, not clip-tuned.
REVALIDATE_MIN_IMPROVEMENT = 0.05


def _anchor_disagrees(cur_box_xyxy, anchor_xywh, iou_thresh: float) -> bool:
    """True when the currently-bound box clearly does NOT overlap the anchor
    box (IoU < iou_thresh) — i.e. the bind is on a different subject than the
    anchor designates. iou_thresh mirrors bind.py's pick_track_for_anchor
    accept floor: below it, the box would not even be considered a match."""
    ax, ay, aw, ah = anchor_xywh
    abox = [ax, ay, ax + aw, ay + ah]
    return _iou_xyxy(abox, cur_box_xyxy) < iou_thresh


# How much bigger (by area) than the ANCHOR a candidate may be before it is a
# balloon rather than the subject that was pointed at. Both anchor-bound call
# sites only fire within ±2 frames of the anchor's timestamp, so the candidate
# and the anchor are effectively simultaneous and their sizes should match
# closely — 1.6x is generous for a same-instant comparison while still
# catching a true full-frame balloon (which is many multiples of a normal
# subject, and >2x even for an anchor that already fills half the frame).
ANCHOR_BALLOON_AREA_RATIO = 1.6


def _is_degenerate_box(
    box,
    W: float,
    H: float,
    anchor_bound: bool = False,
    anchor_xywh=None,
) -> bool:
    """A re-bind candidate that is oversized or frame-edge-pinned is NOT a
    valid subject — binding to it produces the ballooning/cameraman bug.
    Refuse it and stay honestly lost (the quality gate + per-window repair
    then handle it truthfully). Thresholds MIRROR lib/tracking/summary.ts so
    the engine and the quality summary agree on what 'degenerate' means.
    Note: summary.ts applies a 1.5 s minimum-run filter to edge_pinned (post-hoc
    reporting), while this guard fires on a single frame (pre-commit refusal);
    the asymmetry is intentional.

    ``anchor_bound`` — set True when the candidate was selected BY AN ANCHOR
    (pick_track_for_anchor / anchor re-validation). The anchor is identity
    ground truth, and a legitimate close-up subject in a 9:16 PORTRAIT frame
    routinely touches a side edge and is tall/narrow, so the edge-pinned arm
    must NOT veto an anchor pick (the portrait zero-output bug).

    ``anchor_xywh`` — the anchor box the pick was made against, as
    ``[x, y, w, h]``. When supplied, the ABSOLUTE size arms are replaced by an
    anchor-RELATIVE balloon check, because relaxing only the edge arm left the
    same zero-output bug alive for any subject taller than 0.82*H.

    Measured 2026-08-02 on real 1280x720 footage: an astronaut in a normal
    close-up grounded at 0.945 confidence gave a 639x656 anchor. 656 >= 0.82*720
    fired the height arm, every anchor pick was vetoed, and the default
    `yoloe+botsort` method returned `no_output` — 0 visible frames on pristine
    footage that `method:"sot"` then tracked at 98.3%. Close-ups like this are
    not an edge case: talking heads, interviews, UGC selfies and product macros
    all routinely exceed 82% of frame height.

    Against the anchor the question is not "is this box big?" but "has it
    BALLOONED away from what was pointed at?" — which keeps the anti-ballooning
    protection the absolute arms existed for. Without an anchor box (blind
    carry_box re-binds) the absolute arms stay exactly as they were, so the
    background-cameraman false-positive stays refused."""
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    if w <= 0 or h <= 0:
        return True
    if anchor_bound and anchor_xywh is not None:
        aw, ah = float(anchor_xywh[2]), float(anchor_xywh[3])
        if aw > 0 and ah > 0:
            return (w * h) > ANCHOR_BALLOON_AREA_RATIO * (aw * ah)
    if w >= 0.82 * W or h >= 0.82 * H or (w * h) >= 0.55 * W * H:
        return True
    if not anchor_bound and (x1 <= 0.02 * W or x2 >= 0.98 * W) and h > 1.4 * w:
        return True
    return False


def _carry_bound_box(tracks: list, last_bound_xyxy: list | None):
    """Re-acquire the bound identity in a NEW shot from the last known box.

    Returns the track id whose box best overlaps the carried box (IoU >= 0.2),
    else None. None is an HONEST miss — never fall through to an arbitrary
    edge track (that is the cameraman bug).

    IoU >= 0.2 is intentionally low — post-cut positions can shift substantially;
    0.2 still excludes the edge-track false-positive (IoU ~0) while accepting
    meaningful motion. Tunable in the Phase 2.3 empirical pass."""
    if not last_bound_xyxy or not tracks:
        return None
    best_id, best = None, 0.0
    for tid, box in tracks:
        v = _iou_xyxy(last_bound_xyxy, box)
        if v > best:
            best, best_id = v, tid
    return best_id if best >= 0.2 else None


def _capture_anchor_template(reid, template, frame, bound_box, anchor_box) -> None:
    """Add the bound-detection and (optional) anchor-box embeddings to the
    target template. No-op when ReID is disabled. Pure given ``reid``."""
    if not reid.enabled:
        return
    if bound_box is not None:
        bf = reid.get_features(frame, [bound_box])
        if bf is not None and len(bf):
            template.add(bf[0])
    if anchor_box is not None:
        af = reid.get_features(frame, [anchor_box])
        if af is not None and len(af):
            template.add(af[0])


# Appearance-gate cosine floor. Calibrated on real footage in the B+C plan
# (Task 9); LIBI_TRACK_TAU overrides it for the calibration sweep only.
TAU = float(os.environ.get("LIBI_TRACK_TAU", "0.78"))


def _appearance_ok(reid, template, frame, box, tau: float = TAU) -> bool:
    """True when ReID is disabled / the template is empty / the box is
    missing (no opinion → allow), OR the candidate resembles the anchored
    subject (max-ring cosine >= tau). False ONLY when we hold a template AND
    the candidate is confidently dissimilar (the cameraman)."""
    if not reid.enabled or template.empty or box is None:
        return True
    f = reid.get_features(frame, [box])
    if f is None or not len(f):
        return True
    sim = template.similarity(f[0])
    if sim is None:
        return True
    return sim >= tau


def run_segment(job: dict) -> int:
    """Run the tracking pipeline over a single time segment.

    Args:
        job: dict with ``videoPath``, ``fps``, ``range``: ``{start, end}``,
             optional ``classes`` (default ``["person"]``) and ``anchors``:
             ``[{"time": <s>, "bbox": [x, y, w, h]}, ...]``.

    Side effects:
        Emits ``{"type":"progress", ...}`` lines during processing and a
        final ``{"type":"result","samples":[...],"framerate":fps}`` line —
        all to stdout as JSON. Returns ``0`` on success.
    """
    # ── Mask-guided video matting (method "matte") ───────────────────────
    # Fully delegated to libitrack.matte. Lazily dispatched FIRST — matte
    # jobs carry no "fps" field (MatAnyone processes every source frame so
    # the alpha PNGs stay frame-aligned with the source for alphamerge),
    # and torch/matanyone load inside run_matte only (sot.py/headmask.py
    # lazy-heavy-module convention).
    if job.get("method") == "matte":
        from libitrack.matte import run_matte

        return run_matte(job, _emit)

    vp = job["videoPath"]
    fps = float(job["fps"])

    # Shot-detection-only mode: callers (the Node fan-out bridge) ask for the
    # clip's shot ranges without running detect/associate. Emit a result line
    # carrying the shots list and an empty samples list, then return.
    if job.get("method") == "shots":
        shots = detect_shots(vp)
        _emit(
            {
                "type": "result",
                "shots": shots,
                "samples": [],
                "framerate": fps,
            }
        )
        return 0

    # Stage-0 grounding (set-of-marks): run the detector on ONE frame at a
    # given timestamp and return NUMBERED candidate boxes so the agent can pick
    # which object is the target. Mirrors the "shots" branch — fast path that
    # doesn't run the full associate/smooth pipeline.
    if job.get("method") == "ground":
        start = float(job["range"]["start"])
        classes = job.get("classes") or ["person"]
        cap = cv2.VideoCapture(vp)
        # Seek to the requested timestamp (milliseconds).
        cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
        ok, frame = cap.read()
        if not ok:
            # Fallback: read sequentially until we reach the nearest frame.
            cap.release()
            cap = cv2.VideoCapture(vp)
            src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
            target_fidx = int(round(start * src_fps))
            for fidx in range(target_fidx + 1):
                ok, frame = cap.read()
                if not ok:
                    break
        cap.release()
        if not ok or frame is None:
            _emit({"type": "result", "candidates": [], "samples": [], "framerate": fps})
            return 0
        # `anchors` local is not yet bound in this path; read from job directly.
        det = _select_detector(classes, job.get("anchors") or [], job)
        dets = det.detect(frame)
        candidates = []
        for i, (x1, y1, x2, y2, conf, cls) in enumerate(dets.tolist()):
            cls_idx = int(cls)
            label = classes[cls_idx] if cls_idx < len(classes) else str(cls_idx)
            candidates.append(
                {
                    "index": i + 1,
                    "bbox": [x1, y1, x2 - x1, y2 - y1],
                    "label": label,
                    "conf": round(float(conf), 4),
                }
            )
        _emit(
            {
                "type": "result",
                "candidates": candidates,
                "samples": [],
                "framerate": fps,
            }
        )
        return 0

    # ── Identity-candidate disambiguation (method "candidates") ─────────
    # Re-run the EXACT detect→assoc.update loop the default path uses, but
    # instead of binding ONE id and collapsing rivals, group every active
    # tracklet across the window (stitched stable across BoxMOT renumber /
    # shot resets by IoU-continuity — the same primitive _carry_bound_box
    # uses), compute each tracklet's mean cosine-to-anchor-template
    # (reid_sims) + IoU-to-nearest-anchor coverage, retain/rank the rivals,
    # and emit the top-N as `candidateTracklets`. `samples` stays [] so the
    # existing Node parse path is byte-for-byte unaffected. This surfaces the
    # identity ambiguity (Lisa vs a cameraman in matching clothing) that the
    # absolute appearance gate is provably blind to — the agent then visually
    # picks the right tracklet. Implemented strictly from
    # SPIKE-NOTES-candidates.md (Task 0); every constant below is verbatim
    # from that doc's "Constants summary" table (measured on the real repro).
    if job.get("method") == "candidates":
        r0, r1 = float(job["range"]["start"]), float(job["range"]["end"])
        classes = job.get("classes") or ["person"]
        anchors = job.get("anchors") or []

        cap = cv2.VideoCapture(vp)
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        shots = [
            s for s in detect_shots(vp) if s["end"] > r0 and s["start"] < r1
        ]
        det = _select_detector(classes, anchors, job)
        assoc = Associator(frame_rate=int(round(fps)))
        reid = ReidFeatures(assoc.reid_backend)
        template = TargetTemplate(maxlen=4)

        step = max(1, round(src_fps / fps))
        n_out = max(1, int(round((r1 - r0) * fps)))

        # Constants — copied verbatim from SPIKE-NOTES-candidates.md.
        STITCH_IOU_FLOOR = 0.2          # _carry_bound_box accept floor (:262)
        CARRY_GAP_S = 0.5               # conservative vs BoxMOT ~1.0s coast
        X_ANCHOR_COVERAGE = 0.05        # measured: Lisa 67%, cameraman 8%
        DELTA_AMBIG = 0.20              # measured worst gap 0.1753 < 0.20
        N_CAP = 4                       # top-N cap (window had 3 tracklets)

        # candidateId -> aggregate state for the stitched tracklet.
        candidate_tracks: dict = {}
        next_candidate_id = [1]

        cur_shot = object()  # sentinel: first processed frame triggers reset
        # Shot epoch — incremented at every assoc.reset(). Raw BoT-SORT ids
        # restart at 1 after a reset, so the SAME numeric raw id can label
        # two unrelated subjects on opposite sides of a cut (the inter-frame
        # processed gap ≈ 1/fps ≪ CARRY_GAP_S, so Pass-1's same-raw-id stitch
        # would otherwise fire across the cut on numeric collision with NO
        # IoU check — fusing different subjects). Pass-1 is scoped to a
        # single epoch; cross-reset continuity MUST flow through Pass-2's
        # IoU+gap bridge, exactly like the bound path's _carry_bound_box.
        shot_epoch = [0]
        fidx = -1
        done = 0

        def _new_candidate(box_xyxy, t, sim, anchor_iou):
            cid = next_candidate_id[0]
            next_candidate_id[0] += 1
            candidate_tracks[cid] = {
                "perFrame": [],
                "lastBox_xyxy": list(box_xyxy),
                "lastT": t,
                "simSum": 0.0,
                "simN": 0,
                "anchorOkN": 0,
                # rawId/epoch are (re)written by the final loop every frame;
                # seed epoch so the "rawId present ⇒ epoch present" invariant
                # holds even before that write (Pass-1 reads st.get("epoch")).
                "epoch": shot_epoch[0],
            }
            return cid

        def _append(cid, box_xyxy, t, conf, sim, anchor_iou):
            st = candidate_tracks[cid]
            x1, y1, x2, y2 = box_xyxy
            st["perFrame"].append(
                {
                    "t": round(float(t), 4),
                    "bbox": [
                        float(x1),
                        float(y1),
                        float(x2 - x1),
                        float(y2 - y1),
                    ],
                    "conf": round(float(conf), 4),
                }
            )
            st["lastBox_xyxy"] = list(box_xyxy)
            st["lastT"] = t
            if sim is not None:
                st["simSum"] += float(sim)
                st["simN"] += 1
            if anchor_iou is not None and anchor_iou >= IOU_FLOOR_DEFAULT:
                st["anchorOkN"] += 1

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            fidx += 1
            t = fidx / src_fps
            if t < r0 or t > r1:
                continue
            if (fidx % step) != 0:
                continue

            # Keep the existing per-shot associator reset (pipeline.py:599).
            # candidate_tracks is NOT reset — post-reset first-frame tracklets
            # re-match existing candidates via the SAME IoU+gap bridge below,
            # exactly the cross-shot identity carry the bound path gets.
            shot = next(
                (s for s in shots if s["start"] <= t < s["end"]), None
            )
            if shot is not cur_shot:
                assoc.reset()
                cur_shot = shot
                shot_epoch[0] += 1  # raw ids restart → new epoch

            dets = det.detect(frame)
            rows = assoc.update(dets, frame)
            tracks = [
                (int(r[4]), [float(r[0]), float(r[1]), float(r[2]), float(r[3])])
                for r in rows
            ]

            # Seed the target template the SAME way the default path's
            # first-bind does (pipeline.py:695-707): when within
            # (1.0/fps)*2 of an anchor and the template is empty, add the
            # anchor-box embedding + the best-IoU tracklet's embedding so
            # template.similarity has a reference.
            if template.empty and reid.enabled and anchors and tracks:
                na = min(anchors, key=lambda a: abs(a["time"] - t))
                if abs(na["time"] - t) <= (1.0 / fps) * 2:
                    ax, ay, aw, ah = na["bbox"]
                    abox = [ax, ay, ax + aw, ay + ah]
                    best_b, best_v = None, 0.0
                    for _i, b in tracks:
                        v = _iou_xyxy(b, abox)
                        if v > best_v:
                            best_v, best_b = v, b
                    _capture_anchor_template(
                        reid, template, frame, best_b, abox
                    )

            # Per-tracklet cosine-to-template for EVERY active tracklet this
            # frame (the exact reid_sims block at pipeline.py:664-671, but
            # kept for ALL tracklets, not just the rebind path).
            reid_sims = None
            if reid.enabled and not template.empty and tracks:
                feats = reid.get_features(frame, [b for (_i, b) in tracks])
                if feats is not None and len(feats) == len(tracks):
                    reid_sims = {}
                    for (tid, _b), fv in zip(tracks, feats):
                        s = template.similarity(fv)
                        reid_sims[tid] = None if s is None else float(s)

            # Nearest in-window anchor for this frame's IoU-coverage signal.
            near_abox = None
            if anchors:
                near = min(anchors, key=lambda a: abs(a["time"] - t))
                nax, nay, naw, nah = near["bbox"]
                near_abox = [nax, nay, nax + naw, nay + nah]

            # Confidence per raw id, indexed by track order from rows.
            conf_by_idx = [
                float(r[5]) if len(r) > 5 else 1.0 for r in rows
            ]

            # Two-pass per-frame stitch. A candidate receives AT MOST one
            # tracklet per frame, so a still-alive rival can never be
            # IoU-stolen into another candidate (the merge-rivals bug).
            #   Pass 1 — same-raw-id (strict precedence), SCOPED TO THE
            #     CURRENT SHOT EPOCH: a tracklet whose raw_id equals an
            #     existing candidate's current rawId AND was last seen in the
            #     SAME epoch claims that candidate. raw id is reliable only
            #     WITHIN a contiguous run (one epoch) — assoc.reset() at a
            #     cut renumbers from 1, so the epoch gate stops a numeric
            #     raw-id collision across the cut from fusing two unrelated
            #     subjects. Cross-cut continuity instead flows through
            #     Pass-2's IoU bridge — exactly the precedence _resolve_bid
            #     encodes (pipeline.py:104-108), and exactly the cross-reset
            #     identity carry the bound path gets by IoU only.
            #   Pass 2 — IoU bridge (repairs renumber/shot gaps ONLY): an
            #     unmatched tracklet takes the UNCLAIMED candidate whose
            #     lastBox has max IoU, accepting iff IoU >= STITCH_IOU_FLOOR
            #     AND t - lastT <= CARRY_GAP_S — the same continuity
            #     primitive _carry_bound_box uses (pipeline.py:245-262).
            #   Else — mint a new candidateId.
            claimed: set = set()
            frame_match: dict = {}  # ti -> cid
            for ti, (raw_id, _box) in enumerate(tracks):
                for cid, st in candidate_tracks.items():
                    if cid in claimed:
                        continue
                    if (
                        st.get("rawId") == raw_id
                        and st.get("epoch") == shot_epoch[0]
                        and (t - st["lastT"]) <= CARRY_GAP_S
                    ):
                        frame_match[ti] = cid
                        claimed.add(cid)
                        break
            for ti, (raw_id, box) in enumerate(tracks):
                if ti in frame_match:
                    continue
                best_cid, best_iou = None, 0.0
                for cid, st in candidate_tracks.items():
                    if cid in claimed:
                        continue
                    if (t - st["lastT"]) > CARRY_GAP_S:
                        continue
                    v = _iou_xyxy(st["lastBox_xyxy"], box)
                    # Strict `>` ⇒ on an IoU tie the FIRST-iterated (lowest
                    # candidateId, by dict insertion order) wins — a
                    # deterministic, stable tie-break.
                    if v > best_iou:
                        best_iou, best_cid = v, cid
                if best_cid is not None and best_iou >= STITCH_IOU_FLOOR:
                    frame_match[ti] = best_cid
                    claimed.add(best_cid)

            for ti, (raw_id, box) in enumerate(tracks):
                sim = (
                    reid_sims.get(raw_id)
                    if reid_sims is not None
                    else None
                )
                a_iou = (
                    _iou_xyxy(box, near_abox)
                    if near_abox is not None
                    else None
                )
                conf = conf_by_idx[ti] if ti < len(conf_by_idx) else 1.0
                match_cid = frame_match.get(ti)
                if match_cid is None:
                    match_cid = _new_candidate(box, t, sim, a_iou)
                _append(match_cid, box, t, conf, sim, a_iou)
                candidate_tracks[match_cid]["rawId"] = raw_id
                candidate_tracks[match_cid]["epoch"] = shot_epoch[0]

            done += 1
            if done % 5 == 0:
                _emit(
                    {
                        "type": "progress",
                        "done": done,
                        "total": n_out,
                        "unit": "frames",
                    }
                )
        cap.release()
        if done % 5 != 0:
            _emit(
                {
                    "type": "progress",
                    "done": done,
                    "total": n_out,
                    "unit": "frames",
                }
            )

        # Aggregate, retain, rank per the resolved ambiguity rule.
        reid_on = reid.enabled and not template.empty
        retained = []
        for cid, st in candidate_tracks.items():
            pf = st["perFrame"]
            if not pf:
                continue
            mean_sim = (
                (st["simSum"] / st["simN"]) if st["simN"] > 0 else None
            )
            anchor_cov = st["anchorOkN"] / len(pf)
            if reid_on:
                keep = (
                    mean_sim is not None and mean_sim >= (TAU - DELTA_AMBIG)
                ) or anchor_cov >= X_ANCHOR_COVERAGE
            else:
                keep = anchor_cov >= X_ANCHOR_COVERAGE
            if not keep:
                continue
            retained.append(
                {
                    "candidateId": cid,
                    "perFrame": pf,
                    "meanTargetSim": mean_sim if reid_on else None,
                    "frameCount": len(pf),
                    "_anchorCov": anchor_cov,
                }
            )

        # Ranking: meanTargetSim desc, then anchorIoUCoverage desc, then
        # frameCount desc. ReID-off ⇒ meanTargetSim is None (sorts as -1),
        # so coverage is authoritative.
        retained.sort(
            key=lambda c: (
                c["meanTargetSim"] if c["meanTargetSim"] is not None else -1.0,
                c["_anchorCov"],
                c["frameCount"],
            ),
            reverse=True,
        )

        # Ambiguity decision: ReID on ⇒ ≥2 retained AND top-2 meanTargetSim
        # differ by < DELTA_AMBIG. ReID off ⇒ ≥2 retained each with
        # anchorIoUCoverage >= X. Not ambiguous ⇒ emit [].
        ambiguous = False
        if len(retained) >= 2:
            if reid_on:
                s0 = retained[0]["meanTargetSim"]
                s1 = retained[1]["meanTargetSim"]
                if s0 is not None and s1 is not None:
                    ambiguous = abs(s0 - s1) < DELTA_AMBIG
            else:
                ambiguous = (
                    retained[0]["_anchorCov"] >= X_ANCHOR_COVERAGE
                    and retained[1]["_anchorCov"] >= X_ANCHOR_COVERAGE
                )

        out_cands = []
        if ambiguous:
            for c in retained[:N_CAP]:
                out_cands.append(
                    {
                        "candidateId": c["candidateId"],
                        "perFrame": c["perFrame"],
                        "meanTargetSim": c["meanTargetSim"],
                        "frameCount": c["frameCount"],
                    }
                )

        _emit(
            {
                "type": "result",
                "samples": [],
                "framerate": fps,
                "candidateTracklets": out_cands,
            }
        )
        return 0

    # ── Single-object template tracking (method "sot") ──────────────────
    # Unlike the detect+associate path below, SOT NEVER runs the person
    # detector and never binds the anchor to a person box. It locks onto
    # the EXACT anchor region (e.g. a head) with OpenCV VitTrack and
    # follows that template frame-to-frame. Consequences that matter for
    # face overlays: the tracked box stays the anchor's scale (a head
    # anchor → a head-sized box, not a full body), it does not balloon
    # when the subject raises an arm or dances (no person box reshaping),
    # and it cannot id-switch to a different subject such as a cameraman
    # (no associator). Previously `method:"sot"` was a DEAD parameter —
    # run_segment only branched on "shots"/"ground", so "sot" silently ran
    # the identical yoloe+botsort path. This is the real fix.
    if job.get("method") == "sot":
        r0, r1 = float(job["range"]["start"]), float(job["range"]["end"])
        anchors = job.get("anchors") or []
        if not anchors:
            _emit({"type": "result", "samples": [], "framerate": fps})
            return 0
        in_range = [a for a in anchors if r0 <= float(a["time"]) <= r1]
        anchor = (
            in_range[0]
            if in_range
            else min(anchors, key=lambda a: abs((r0 + r1) / 2 - float(a["time"])))
        )
        a_t = float(anchor["time"])
        seed_box = [float(v) for v in anchor["bbox"]]  # [x, y, w, h]

        cap = cv2.VideoCapture(vp)
        src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        step = max(1, round(src_fps / fps))
        n_out = max(1, int(round((r1 - r0) * fps)))

        # Downscale frames fed to VitTrack so a full-clip SOT stays within
        # a sane memory/CPU budget. The seed box is scaled by the SAME
        # factor (init/track consistency); outputs are scaled back to
        # source pixels. Cap the buffered pre-anchor frames; anything
        # older than the cap is an honest visible:false.
        SOT_MAX_DIM = 720
        BACKWARD_MAX = 900

        samples_by_t: dict = {}
        pre_buf: list = []  # (t, small_frame) for r0..anchor (reversed later)
        scale = None
        fidx = -1
        done = 0
        fwd = None
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            fidx += 1
            t = fidx / src_fps
            if t < r0:
                continue
            if t > r1:
                break
            if (fidx % step) != 0:
                continue
            if scale is None:
                h0, w0 = fr.shape[:2]
                scale = min(1.0, SOT_MAX_DIM / float(max(w0, h0)))
            small = (
                cv2.resize(
                    fr, (int(fr.shape[1] * scale), int(fr.shape[0] * scale))
                )
                if scale < 1.0
                else fr
            )
            if fwd is None:
                if t < a_t - (step / src_fps):
                    pre_buf.append((round(t, 4), small))
                    if len(pre_buf) > BACKWARD_MAX:
                        pre_buf.pop(0)
                    done += 1
                    continue
                sb = [v * scale for v in seed_box]
                fwd = SotTracker(small, sb)
                samples_by_t[round(t, 4)] = list(seed_box) if fwd.ok else None
            else:
                box = fwd.track(small) if fwd.ok else None
                samples_by_t[round(t, 4)] = (
                    [c / scale for c in box] if box else None
                )
            done += 1
            if done % 5 == 0:
                _emit(
                    {"type": "progress", "done": done, "total": n_out, "unit": "frames"}
                )
        cap.release()

        # Backward pass: a FRESH tracker seeded at the anchor box, fed the
        # buffered pre-anchor frames newest→oldest so r0..anchor is covered
        # too (fixes "0–4s shows nothing" when the subject is only anchored
        # later in the clip).
        if pre_buf and scale is not None:
            sb = [v * scale for v in seed_box]
            bwd = SotTracker(pre_buf[-1][1], sb)
            for (t, small) in reversed(pre_buf):
                box = bwd.track(small) if bwd.ok else None
                samples_by_t[round(t, 4)] = (
                    [c / scale for c in box] if box else None
                )

        samples = []
        for t in sorted(samples_by_t.keys()):
            b = samples_by_t[t]
            if b and b[2] > 0 and b[3] > 0:
                samples.append(
                    {
                        "t": t,
                        "x": float(b[0]),
                        "y": float(b[1]),
                        "w": float(b[2]),
                        "h": float(b[3]),
                        "confidence": 0.9,
                        "visible": True,
                    }
                )
            else:
                samples.append(
                    {
                        "t": t,
                        "x": 0.0,
                        "y": 0.0,
                        "w": 0.0,
                        "h": 0.0,
                        "confidence": 0.0,
                        "visible": False,
                    }
                )
        samples = smooth_samples(samples)
        _emit({"type": "result", "samples": samples, "framerate": fps})
        return 0

    r0, r1 = float(job["range"]["start"]), float(job["range"]["end"])
    classes = job.get("classes") or ["person"]
    anchors = job.get("anchors") or []
    # Head-refine: keep the robust yoloe+botsort person track for SUBJECT
    # identity (anchors + ReID + the repair loop pick the right person),
    # but emit the HEAD sub-region derived from that person's segmentation
    # silhouette instead of the body box. Triggered by objectKind:"face"
    # (so `compute_object_track`/`compute_track_segment` with a face
    # objectKind "just works") or an explicit headRefine flag.
    head_refine = bool(job.get("headRefine")) or job.get("objectKind") == "face"

    cap = cv2.VideoCapture(vp)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0

    # Only the shots that overlap the requested segment matter.
    shots = [s for s in detect_shots(vp) if s["end"] > r0 and s["start"] < r1]

    det = _select_detector(classes, anchors, job)
    # Real ReID is wanted (with_reid defaults True). frame_rate feeds the
    # BoT-SORT track-buffer math; the output sampling rate is the right value
    # here since we only feed sampled frames to the tracker.
    assoc = Associator(frame_rate=int(round(fps)))
    reid = ReidFeatures(assoc.reid_backend)
    template = TargetTemplate(maxlen=4)
    TEMPLATE_REFRESH = 15  # add a high-conf bound embedding every Nth frame

    samples: list[dict] = []
    step = max(1, round(src_fps / fps))
    n_out = max(1, int(round((r1 - r0) * fps)))

    cur_shot = object()  # sentinel: first processed frame always triggers reset
    bound_id = None
    anchor_veto_count = 0  # anchor-picked candidates refused as degenerate (diagnostic)
    carry_box = None
    # Per-shot bind-event list: (buf_index, id) pairs recording WHERE in the
    # shot buffer the subject was (re)bound and to WHICH id. BoxMOT renumbers
    # a track across an occlusion EVEN WITHIN ONE SHOT, so a shot can have
    # more than one bind event (e.g. id 1 then id 3). _flush_shot resolves the
    # per-frame id from this list. Reset to [] at every shot boundary.
    binds: list[tuple[int, int]] = []
    done = 0
    fidx = -1
    # Per-shot frame buffer: (t, tracks) pairs deferred until the shot ends.
    # Sample emission is delayed so the shot's FINAL bound_id can be
    # back-propagated to every frame in the shot (incl. pre-anchor frames).
    # Progress still ticks per processed frame below — only the *sample
    # dict* creation is deferred to _flush_shot.
    shot_buf: list = []

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        fidx += 1
        t = fidx / src_fps
        if t < r0 or t > r1:
            continue
        if (fidx % step) != 0:
            continue

        # Frame dimensions for the degenerate-rebind guard below. `frame` is
        # a valid BGR HxWx3 array here (cap.read() succeeded and t is in
        # range). No W/H exists in this path's scope otherwise.
        H, W = frame.shape[:2]

        # Which shot owns this timestamp? (None when outside any detected shot.)
        shot = next((s for s in shots if s["start"] <= t < s["end"]), None)
        if shot is not cur_shot:
            # Shot boundary: flush the just-ended shot with its FINAL
            # bound_id (back-propagating to that shot's pre-anchor frames),
            # then reset associator + binding + buffer for the new shot.
            # Remember where the bound subject was at the END of the shot we
            # are flushing, so the next shot can re-acquire the SAME person
            # even if it has no anchor of its own.
            last_bound_xyxy = None
            if bound_id is not None and shot_buf:
                for it in reversed(shot_buf):
                    sel = next((b for (i, b) in it[1] if i == bound_id), None)
                    if sel is not None:
                        last_bound_xyxy = list(sel)
                        break
            _flush_shot(shot_buf, binds, samples)
            shot_buf = []
            binds = []
            assoc.reset()
            cur_shot = shot
            bound_id = None
            carry_box = last_bound_xyxy

        if head_refine:
            dets, masks = det.detect_seg(frame)
        else:
            dets, masks = det.detect(frame), None
        rows = assoc.update(dets, frame)
        tracks = [
            (int(r[4]), [float(r[0]), float(r[1]), float(r[2]), float(r[3])])
            for r in rows
        ]

        # When head-refining, resolve each track's HEAD box now: match the
        # track box to its detection (best IoU) → that detection's
        # silhouette mask → head_box_from_mask. None when no mask / no
        # plausible head (handled by _flush_shot's top-band fallback).
        head_by_id = None
        if head_refine:
            head_by_id = {}
            for tid, tbox in tracks:
                best_i, best_iou = -1, 0.0
                for di in range(len(dets)):
                    v = _iou_xyxy(tbox, dets[di][:4])
                    if v > best_iou:
                        best_iou, best_i = v, di
                hb = None
                if best_i >= 0 and best_iou >= 0.3 and masks is not None:
                    hb = head_box_from_mask(masks[best_i], dets[best_i][:4])
                head_by_id[tid] = hb

        # (Re)bind the subject. Bind not just when unset but ALSO when the
        # currently-bound BoxMOT id has died/renumbered — BoxMOT reassigns
        # track ids across an occlusion EVEN WITHIN ONE SHOT, so a stale
        # bound_id can no longer be found among `tracks`. Anchor is always
        # preferred; carry_box (appearance/position continuity) is the
        # fallback only when no anchor is near.
        bound_present = bound_id is not None and any(
            i == bound_id for (i, _b) in tracks
        )
        if bound_id is None or not bound_present:
            # The bound id is unset, or its BoxMOT track died/renumbered.
            # Refresh carry_box to the last-known bound box so between-anchor
            # frames can re-acquire by appearance/position continuity.
            if (
                bound_id is not None
                and not bound_present
                and shot_buf
                and carry_box is None
            ):
                # Only scan ONCE, when the id first dies. `carry_box` is
                # re-armed to None after a successful re-bind below, so a
                # subsequent loss rescans correctly. If carry_box is already
                # non-None (e.g. the multi-shot boundary stash set it), we
                # already have a box to re-acquire by — skipping the rescan
                # is correct.
                for it in reversed(shot_buf):
                    sel = next(
                        (b for (i, b) in it[1] if i == bound_id), None
                    )
                    if sel is not None:
                        carry_box = list(sel)
                        break
            reid_sims = None
            if reid.enabled and not template.empty and tracks:
                feats = reid.get_features(frame, [b for (_i, b) in tracks])
                if feats is not None and len(feats) == len(tracks):
                    reid_sims = {}
                    for (tid, _b), fv in zip(tracks, feats):
                        s = template.similarity(fv)
                        reid_sims[tid] = 0.0 if s is None else float(s)
            new_id = None
            anchor_bound = False
            anchor_ref = None  # the anchor box an anchor-bound pick was made against
            if anchors:
                near = min(anchors, key=lambda a: abs(a["time"] - t))
                if abs(near["time"] - t) <= (1.0 / fps) * 2 and tracks:
                    new_id = pick_track_for_anchor(
                        tracks, near["bbox"], reid_sims=reid_sims
                    )
                    if new_id is not None:
                        # Identity ground truth requires the picked box to
                        # actually MEET the accept floor: pick_track_for_anchor
                        # falls back to a below-floor best-IoU (or ReID) pick,
                        # and such a pick may still bind — but under BLIND
                        # re-bind rules (edge arm active). Otherwise a garbage
                        # low-IoU "anchor bind" bypasses the degenerate veto.
                        # Shared floor: _anchor_disagrees ← IOU_FLOOR_DEFAULT.
                        picked = next(
                            (b for (i, b) in tracks if i == new_id), None
                        )
                        anchor_bound = picked is not None and not _anchor_disagrees(
                            picked, near["bbox"], IOU_FLOOR_DEFAULT
                        )
                        if anchor_bound:
                            anchor_ref = near["bbox"]
            if new_id is None and carry_box is not None and tracks:
                new_id = _carry_bound_box(tracks, carry_box)
                anchor_bound = False  # blind continuity re-bind — edge arm active
                anchor_ref = None
            if new_id is not None:
                cand = next((b for (i, b) in tracks if i == new_id), None)
                if cand is not None and _is_degenerate_box(
                    cand, W, H, anchor_bound=anchor_bound, anchor_xywh=anchor_ref
                ):
                    if anchor_bound:
                        anchor_veto_count += 1
                    new_id = None  # refuse a degenerate re-bind — stay honestly lost
            if new_id is not None:
                cand = next((b for (i, b) in tracks if i == new_id), None)
                if cand is not None and not _appearance_ok(
                    reid, template, frame, cand
                ):
                    new_id = None  # refuse a dissimilar subject (the cameraman)
            if new_id is not None:
                bound_id = new_id
                binds.append((len(shot_buf), new_id))
                carry_box = None
                if template.empty and reid.enabled:
                    cand_box = next(
                        (b for (i, b) in tracks if i == bound_id), None
                    )
                    anchor_box = None
                    if anchors:
                        na = min(anchors, key=lambda a: abs(a["time"] - t))
                        if abs(na["time"] - t) <= (1.0 / fps) * 2:
                            ax, ay, aw, ah = na["bbox"]
                            anchor_box = [ax, ay, ax + aw, ay + ah]
                    _capture_anchor_template(
                        reid, template, frame, cand_box, anchor_box
                    )

        # Anchor re-validation: a PRESENT bind that disagrees with a nearby
        # anchor is on the wrong subject (the cameraman/duet-partner bug) —
        # the anchor is identity ground truth, so switch to its track.
        if bound_id is not None and anchors:
            near = min(anchors, key=lambda a: abs(a["time"] - t))
            if abs(near["time"] - t) <= (1.0 / fps) * 2 and tracks:
                bound_box = next(
                    (b for (i, b) in tracks if i == bound_id), None
                )
                if bound_box is not None and _anchor_disagrees(
                    bound_box, near["bbox"], ANCHOR_REVALIDATE_IOU
                ):
                    reval = pick_track_for_anchor(
                        tracks, near["bbox"], reid_sims=None
                    )
                    if reval is not None and reval != bound_id:
                        rb = next((b for (i, b) in tracks if i == reval), None)
                        rb_degenerate = rb is not None and _is_degenerate_box(
                            rb, W, H, anchor_bound=True, anchor_xywh=near["bbox"]
                        )
                        if rb_degenerate:
                            # Same diagnostic as the anchor-pick veto: an
                            # anchor-selected candidate refused as degenerate
                            # must leave a trace (T8 counter covers BOTH sites).
                            anchor_veto_count += 1
                        if (
                            rb is not None
                            and not rb_degenerate
                            and _appearance_ok(reid, template, frame, rb)
                        ):
                            ax, ay, aw, ah = near["bbox"]
                            abox = [ax, ay, ax + aw, ay + ah]
                            reval_iou = _iou_xyxy(rb, abox)
                            cur_iou = _iou_xyxy(bound_box, abox)
                            if (
                                reval_iou >= ANCHOR_REVALIDATE_IOU
                                and reval_iou > cur_iou
                                + REVALIDATE_MIN_IMPROVEMENT
                            ):
                                bound_id = reval
                                binds.append((len(shot_buf), reval))
                                carry_box = None

        # Defer the sample: buffer the frame's tracks for this shot. The
        # bound_id may still change later this shot; _flush_shot resolves
        # the final identity against every buffered frame's tracks. When
        # head-refining, the per-frame head map rides along so the flush
        # emits the head box for whichever id ends up bound.
        if (
            reid.enabled
            and not template.empty
            and bound_id is not None
            and done >= TEMPLATE_REFRESH
            and (done % TEMPLATE_REFRESH) == 0
        ):
            cb = next((b for (i, b) in tracks if i == bound_id), None)
            if cb is not None and not _is_degenerate_box(cb, W, H):
                rf = reid.get_features(frame, [cb])
                if rf is not None and len(rf):
                    template.add(rf[0])

        frame_sim = None
        if reid.enabled and not template.empty and bound_id is not None:
            bb = next((b for (i, b) in tracks if i == bound_id), None)
            if bb is not None:
                ff = reid.get_features(frame, [bb])
                if ff is not None and len(ff):
                    s = template.similarity(ff[0])
                    frame_sim = None if s is None else float(s)
        if head_refine:
            shot_buf.append((t, tracks, head_by_id, frame_sim))
        else:
            shot_buf.append((t, tracks, None, frame_sim))

        done += 1
        if done % 5 == 0:
            _emit(
                {"type": "progress", "done": done, "total": n_out, "unit": "frames"}
            )

    # Flush the final (still-open) shot's buffer with its per-frame binds.
    _flush_shot(shot_buf, binds, samples)

    if anchor_veto_count > 0:
        logger.info(
            "anchor-selected candidate refused as degenerate %d time(s) in "
            "range %.3f-%.3f — anchor-pick + re-validation sites, "
            "oversize/area veto (edge arm already relaxed for anchor "
            "selections); if the whole track is empty this is why",
            anchor_veto_count,
            r0,
            r1,
        )

    cap.release()

    # Always emit at least one progress line even on a very short segment.
    if done % 5 != 0:
        _emit({"type": "progress", "done": done, "total": n_out, "unit": "frames"})

    samples = smooth_samples(samples)
    _emit({"type": "result", "samples": samples, "framerate": fps})
    return 0

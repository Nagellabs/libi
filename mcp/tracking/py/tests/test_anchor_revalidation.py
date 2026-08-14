"""Anchor re-validation: a PRESENT-but-WRONG bind near an anchor switches.

Root cause this guards against:

``run_segment`` binds the tracked subject to a BoxMOT id. Task 2.2b
re-binds when the bound id is ABSENT from ``tracks`` (``bound_id is None
or not bound_present``). But in a duet/cameraman scenario the bind can go
to the WRONG-but-ALIVE id (e.g. a cameraman who enters and is then tracked
stably). Because ``bound_present`` stays True, the 2.2b re-bind block
never fires, and the dense anchors on the REAL subject are never consulted
— the subject is "tracked" on the wrong person for the back third.

Fix: an anchor is identity ground truth. If we are near an anchor time and
the currently-bound box clearly disagrees with that anchor (IoU below the
same floor ``pick_track_for_anchor`` uses to even accept a match), the
bind is on the wrong subject — re-bind to the anchor's track.
"""
import json
import pathlib

import numpy as np
import pytest

from libitrack import pipeline
from libitrack.pipeline import _anchor_disagrees, run_segment

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)


def test_bound_box_far_from_anchor_disagrees():
    # anchor xywh (centre-ish subject); bound box is the cameraman at the
    # left edge -> ~zero IoU -> disagrees.
    anchor_xywh = [300.0, 250.0, 120.0, 200.0]      # x,y,w,h
    cameraman_xyxy = [0.0, 100.0, 28.0, 520.0]      # x1,y1,x2,y2
    assert _anchor_disagrees(cameraman_xyxy, anchor_xywh, 0.1) is True


def test_bound_box_on_anchor_agrees():
    # bound box ~= the anchor region -> high IoU -> does NOT disagree.
    anchor_xywh = [300.0, 250.0, 120.0, 200.0]
    on_subject_xyxy = [305.0, 248.0, 422.0, 452.0]  # ~ x..x+w, y..y+h
    assert _anchor_disagrees(on_subject_xyxy, anchor_xywh, 0.1) is False


# ── Integration test ────────────────────────────────────────────────────
#
# ONE shot, two tracks throughout:
#   id 1  = the real subject (centre of frame, slowly drifting right)
#   id 9  = a decoy / cameraman (pinned at the left edge, always alive)
#
# Anchor #1 is placed so it is spatially closest to id 9 (so
# pick_track_for_anchor binds the WRONG id 9), and id 9 persists the WHOLE
# clip so the 2.2b absent-rebind path NEVER fires (bound_present stays
# True). Anchor #2, later, sits on the REAL subject (id 1's region).
#
# Pre-fix: the bind is stuck on id 9 -> late samples track id 9's box.
# Post-fix: anchor re-validation at anchor #2 switches the bind to id 1 ->
# late samples track id 1's box.

REPO = pathlib.Path(__file__).resolve().parents[4]
FIX = str(REPO / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4")

# id 9 — the decoy: a tall narrow box pinned at the left edge for the whole
# clip. NOT degenerate (well inside the _is_degenerate_box thresholds for
# the fixture's ~1280x720-ish frame: width small, not edge-pinned-tall
# enough to trip the edge guard given h <= 1.4*w is false only when very
# tall; we keep it comfortably non-degenerate).
DECOY_XYXY = [120.0, 220.0, 240.0, 460.0]  # x1,y1,x2,y2 (w=120, h=240)


def _subject_xyxy(n: int):
    """The real subject: a centre box that drifts right with frame index so
    its trajectory is clearly distinct from the static decoy."""
    x1 = 480.0 + 4.0 * n
    return [x1, 280.0, x1 + 200.0, 600.0]


class _TwoPeopleDetector:
    """Two person detections every frame: the decoy + the moving subject."""

    def __init__(self, classes, **_):
        self.classes = classes
        self._n = 0

    def detect(self, frame):
        n = self._n
        self._n += 1
        d = DECOY_XYXY
        s = _subject_xyxy(n)
        return np.array(
            [
                [d[0], d[1], d[2], d[3], 0.95, 0.0],
                [s[0], s[1], s[2], s[3], 0.95, 0.0],
            ],
            dtype=np.float32,
        )

    def detect_seg(self, frame):
        return self.detect(frame), []


class _StableTwoTrackAssociator:
    """Returns BOTH tracks every frame with STABLE ids: id 9 = decoy,
    id 1 = the moving subject. Neither id ever dies (so the 2.2b
    absent-rebind path is never exercised — only the present-but-wrong
    re-validation path can fix the bind)."""

    reid_backend = None  # motion-only mock; ReidFeatures(None) → disabled

    def __init__(self, **_):
        self._n = 0

    def update(self, dets, frame):
        n = self._n
        self._n += 1
        d = DECOY_XYXY
        s = _subject_xyxy(n)
        # Nx8: [x1, y1, x2, y2, track_id, conf, cls, det_ind]
        return np.array(
            [
                [d[0], d[1], d[2], d[3], 9, 0.95, 0.0, 0.0],
                [s[0], s[1], s[2], s[3], 1, 0.95, 0.0, 1.0],
            ],
            dtype=np.float32,
        )

    def reset(self):
        self._n = 0


def test_present_but_wrong_bind_revalidated_to_anchor_track(
    capsys, monkeypatch
):
    # Single shot spanning the whole clip — NO cut. The only id-changing
    # mechanism available is anchor re-validation (both ids are alive the
    # whole time, so 2.2b's absent-rebind cannot fire).
    monkeypatch.setattr(
        pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}]
    )
    monkeypatch.setattr(pipeline, "Detector", _TwoPeopleDetector)
    monkeypatch.setattr(
        pipeline, "Associator", lambda *a, **k: _StableTwoTrackAssociator()
    )

    # Anchor #1 early, placed ON THE DECOY (id 9) region so
    # pick_track_for_anchor binds the WRONG id 9 first.
    # Anchor #2 late, placed ON THE REAL SUBJECT (id 1) region.
    # Subject box at n: x1 = 480 + 4n. At fps=5/step5, sampled n grows ~5
    # per second of source; the late anchor sits where id 1 actually is.
    anchor1_xywh = [120, 220, 120, 240]  # == DECOY_XYXY as xywh
    # id 1 around t≈3.6s: source fidx ≈ 90, sampled n ≈ 18 -> x1 ≈ 552
    anchor2_xywh = [552, 280, 200, 320]

    job = {
        "videoPath": FIX,
        "fps": 5,
        "range": {"start": 0.0, "end": 5.0},
        "method": "yoloe+botsort",
        "classes": ["person"],
        "anchors": [
            {"time": 0.2, "bbox": anchor1_xywh},
            {"time": 3.6, "bbox": anchor2_xywh},
        ],
        "exemplarPath": None,
    }
    rc = run_segment(job)
    assert rc == 0

    lines = [
        json.loads(l)
        for l in capsys.readouterr().out.strip().splitlines()
        if l.strip()
    ]
    res = [l for l in lines if l["type"] == "result"][-1]
    samples = res["samples"]
    assert samples, "expected samples"

    ts = [s["t"] for s in samples]
    assert ts == sorted(ts), "samples must be in time order"

    # Early span: bound to the WRONG decoy id 9 (anchor #1 closest to it).
    early = [s for s in samples if s["visible"] and s["t"] < 1.0]
    assert early, "expected visible samples early (bind to decoy id 9)"
    for s in early:
        # id 9 (decoy) box is the static DECOY_XYXY: x in [120, 240].
        assert abs(s["x"] - DECOY_XYXY[0]) < 30.0, (
            f"early bind should be the decoy id 9 (x≈{DECOY_XYXY[0]}); "
            f"got x={s['x']}"
        )

    # Late span (after anchor #2 at 3.6s): re-validation must have switched
    # the bind to id 1 (the real subject). id 1's box drifts right
    # (x1 = 480 + 4n) so it is far from the static decoy x≈120.
    late = [s for s in samples if s["visible"] and s["t"] > 4.0]
    assert late, "expected visible samples late"
    for s in late:
        assert s["x"] > 480.0, (
            "post-anchor#2 the bind must be re-validated to the real "
            f"subject id 1 (x>480, drifting right), NOT the decoy id 9 "
            f"(x≈120). got x={s['x']}"
        )

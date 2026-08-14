"""Regression: re-bind the subject when BoxMOT renumbers it WITHIN one shot.

Root cause this guards against:

The pipeline binds the tracked subject to a single BoT-SORT track id
(``bound_id``) and the old per-frame bind block only (re)bound when
``bound_id is None``. ``bound_id`` was reset to ``None`` ONLY at a shot
boundary. But BoxMOT renumbers a track across an occlusion EVEN WITHIN ONE
SHOT (the detector and tracker keep the subject the whole time, just under
a new id, e.g. id 1 -> id 3). With no shot boundary, ``bound_id`` stayed
the now-dead id 1, the bind never recovered, and ``_flush_shot`` emitted
``visible:false`` for the entire post-renumber span — the subject was
reported "lost" for most of the clip though it was fully detected/tracked
throughout.

This test drives ``run_segment`` over a SINGLE shot (no cut) where a
synthetic associator returns the subject as id ``1`` for the first half of
sampled frames, then renumbers it to id ``3`` (same spatial box
trajectory) for the second half, with a detection present every frame. It
provides an anchor near the start (binds id 1) AND a later anchor (near
where id 3 lives) — matching the real fixture's dense-anchor situation.

Before the fix: the late (id-3) span is ``visible:false`` (bound_id stuck
on dead id 1) and this test FAILS. After the fix: both spans are
``visible:true``.
"""
import json
import pathlib

import numpy as np
import pytest

from libitrack import pipeline
from libitrack.pipeline import run_segment

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)

REPO = pathlib.Path(__file__).resolve().parents[4]
FIX = str(REPO / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4")

# The fixture is 25fps / 125 frames / 5s. Sampling at fps=5 -> step 5 ->
# t = 0.0, 0.2, 0.4, ... (~26 sampled frames over [0, 5]).
SUBJECT_BOX = [400.0, 300.0, 700.0, 800.0]  # x1,y1,x2,y2 — constant trajectory


class _FakeDetector:
    """One person detection per frame, at the subject box (id-agnostic)."""

    def __init__(self, classes, **_):
        self.classes = classes

    def detect(self, frame):
        x1, y1, x2, y2 = SUBJECT_BOX
        return np.array([[x1, y1, x2, y2, 0.95, 0.0]], dtype=np.float32)

    def detect_seg(self, frame):
        return self.detect(frame), []


class _RenumberAssociator:
    """Returns the subject under id 1 for the first ``flip`` calls, then
    renumbers to id 3 — the SAME spatial box (BoxMOT occlusion renumber).
    """

    reid_backend = None  # motion-only mock; ReidFeatures(None) → disabled

    def __init__(self, flip_after: int, **_):
        self._n = 0
        self._flip = flip_after

    def update(self, dets, frame):
        self._n += 1
        tid = 1 if self._n <= self._flip else 3
        x1, y1, x2, y2 = SUBJECT_BOX
        # Nx8: [x1, y1, x2, y2, track_id, conf, cls, det_ind]
        return np.array(
            [[x1, y1, x2, y2, tid, 0.95, 0.0, 0.0]], dtype=np.float32
        )

    def reset(self):
        # Single shot — reset is never expected to be called here.
        self._n = 0


def test_subject_recovered_after_boxmot_renumber_within_one_shot(
    capsys, monkeypatch
):
    # Single shot spanning the whole clip — NO cut, so the only thing that
    # can change the id is BoxMOT's mid-shot renumber.
    monkeypatch.setattr(
        pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}]
    )
    monkeypatch.setattr(pipeline, "Detector", _FakeDetector)
    # ~26 sampled frames; renumber roughly half-way through.
    monkeypatch.setattr(
        pipeline,
        "Associator",
        lambda *a, **k: _RenumberAssociator(flip_after=13),
    )

    job = {
        "videoPath": FIX,
        "fps": 5,
        "range": {"start": 0.0, "end": 5.0},
        "method": "yoloe+botsort",
        "classes": ["person"],
        # Dense-anchor situation: one near the start (binds id 1) AND one
        # in the second half (where the subject is id 3).
        "anchors": [
            {"time": 0.2, "bbox": [400, 300, 300, 500]},
            {"time": 3.6, "bbox": [400, 300, 300, 500]},
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
    assert all(t <= 5.0 + 1e-6 for t in ts), "samples must be segment-scoped"

    visible = [s for s in samples if s["visible"]]
    early_visible = [s for s in visible if s["t"] < 2.0]
    late_visible = [s for s in visible if s["t"] > 3.0]

    assert early_visible, (
        "expected visible samples in the early (id-1) span — the start "
        "anchor should bind id 1"
    )
    # The core regression assertion: the LATE span (after the BoxMOT
    # renumber to id 3) must ALSO be visible. Pre-fix this is empty because
    # bound_id stuck on the dead id 1 and never re-bound mid-shot.
    assert late_visible, (
        "expected visible samples in the late (id-3) span; the subject was "
        "renumbered 1->3 within ONE shot and the bind never recovered "
        "(bound_id stuck on dead id 1)"
    )

    # Nearly every sampled frame should be visible — the subject is detected
    # and tracked the WHOLE clip, only its id changes once.
    assert len(visible) >= int(0.9 * len(samples)), (
        f"expected >=90% visible (subject tracked throughout); got "
        f"{len(visible)}/{len(samples)}"
    )

    # Recovered samples carry a real bbox + the standard visible convention.
    for s in visible:
        assert s["w"] > 0 and s["h"] > 0
        assert s["confidence"] == 0.9
        assert set(s) >= {"t", "x", "y", "w", "h", "confidence", "visible"}

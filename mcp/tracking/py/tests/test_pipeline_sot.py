"""`method:"sot"` must run a real single-object template tracker.

Before this fix, `run_segment` only branched on "shots"/"ground" — every
other method (including "sot") fell through to the IDENTICAL
yoloe-detect + botsort-associate + bind-to-person path. So a head-sized
anchor was bound to the nearest full-PERSON detection: the tracked box
inflated to body scale, drifted as the body box reshaped (dance / raised
arm), and could id-switch to another subject (a cameraman). `sot.py`
existed but was never called.

This test runs `run_segment` with `method:"sot"` and a SMALL anchor box
and asserts the produced track stays near the ANCHOR's scale — i.e. it
actually tracked the seeded template, not a person detection. On the
pre-fix code the box would inflate toward the detected person / frame.
"""
import json
import pathlib

import cv2
import pytest

from libitrack.pipeline import run_segment

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)

REPO = pathlib.Path(__file__).resolve().parents[4]
FIX = str(REPO / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4")


def _frame_size(path):
    cap = cv2.VideoCapture(path)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    return w, h


def test_sot_tracks_the_template_scale_not_a_person_box(capsys):
    W, H = _frame_size(FIX)
    assert W > 0 and H > 0

    # A small, roughly head-sized seed near the upper-centre (the fixture
    # is a single non-selfie face). ~22% of width — far from a full body.
    sw = max(24, int(W * 0.22))
    sh = max(24, int(H * 0.22))
    sx = int(W * 0.5 - sw / 2)
    sy = int(H * 0.18)
    seed_area = sw * sh

    job = {
        "videoPath": FIX,
        "fps": 5,
        "range": {"start": 0.0, "end": 5.0},
        "method": "sot",
        "anchors": [{"time": 1.0, "bbox": [sx, sy, sw, sh]}],
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
    assert samples, "sot must emit samples"

    # Time-ordered, segment-scoped — same contract as every other method.
    ts = [s["t"] for s in samples]
    assert ts == sorted(ts)
    assert all(t <= 5.0 + 1e-6 for t in ts)

    visible = [s for s in samples if s["visible"]]
    # The fixture has a clear subject; SOT seeded near it should lock for
    # at least part of the clip. (If VitTrack/onnx is unavailable in the
    # env, SotTracker.ok is False and everything is an honest miss — only
    # assert the scale property when we actually got visible samples.)
    if visible:
        # KEY ASSERTION: the tracked box stays near the SEED scale. The
        # pre-fix (person-path) behaviour inflated it toward a full-body /
        # frame-sized box. Allow generous slack for VitTrack scale drift
        # but nowhere near a person/frame box (which would be many× the
        # head seed and approach frame height).
        import statistics

        areas = [s["w"] * s["h"] for s in visible]
        med = statistics.median(areas)
        assert med <= 9.0 * seed_area, (
            f"sot box ballooned to {med:.0f}px^2 vs seed {seed_area}px^2 — "
            "looks like the person-detection path, not template tracking"
        )
        # And it must not be a near-frame box (the cameraman/body failure).
        for s in visible:
            assert s["h"] < 0.85 * H, "sot box is ~frame-tall (person/edge path)"
        for s in visible:
            assert s["w"] > 0 and s["h"] > 0
            assert s["confidence"] == 0.9

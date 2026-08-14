"""Regression: bound-id back-propagation within a shot.

The old pipeline bound the anchor->subject identity forward-only: it walked
frames in time order and only started emitting ``visible:true`` samples from
the first frame at/after an anchor's timestamp.  Every frame BEFORE that
anchor was emitted as a zeroed ``visible:false`` "honest miss" — even though
the BoT-SORT associator had a stable track for the subject the whole time
(track ids only reset at shot boundaries).

The fix buffers per-frame ``(t, tracks)`` and, when a shot ends, flushes the
shot's frames using the shot's final ``bound_id`` — so pre-anchor frames in
which the bound id existed are recovered as visible.

This test runs ``run_segment`` over the 5s person fixture with a SINGLE
anchor near the END of the clip and asserts that visible samples exist for
frames well BEFORE the anchor's time.  It MUST FAIL on the pre-fix code
(everything before the anchor is invisible) and PASS after the fix.
"""
import json
import pathlib

import pytest

from libitrack.pipeline import run_segment

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)

REPO = pathlib.Path(__file__).resolve().parents[4]
FIX = str(REPO / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4")

ANCHOR_TIME = 4.0


def test_pre_anchor_frames_are_recovered_within_shot(capsys):
    # The fixture has a single person visible from t=0. A plausible
    # roughly-centered box at ~4s; pick_track_for_anchor uses IoU primary
    # so the box only needs to overlap the detected person at the anchor's
    # frame for the bind to land. Asserting leniently below.
    job = {
        "videoPath": FIX,
        "fps": 5,
        "range": {"start": 0.0, "end": 5.0},
        "method": "yoloe+botsort",
        "classes": ["person"],
        "anchors": [{"time": ANCHOR_TIME, "bbox": [40, 40, 360, 480]}],
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

    visible = [s for s in samples if s["visible"]]
    assert visible, "expected at least one visible sample (anchor should bind)"

    # The core regression assertion: at least one visible sample exists for a
    # frame well BEFORE the anchor's timestamp. On the pre-fix forward-only
    # code there are ZERO visible samples before ANCHOR_TIME, so this fails.
    pre_anchor_visible = [s for s in visible if s["t"] < ANCHOR_TIME - 0.5]
    assert pre_anchor_visible, (
        f"expected >=1 visible sample at t < {ANCHOR_TIME - 0.5}; "
        f"first visible t = {min(s['t'] for s in visible)} "
        f"(forward-only binding leaves all pre-anchor frames invisible)"
    )

    # Sanity: the recovered pre-anchor samples carry a real (non-zero) bbox
    # and the standard visible-branch confidence convention.
    for s in pre_anchor_visible:
        assert s["w"] > 0 and s["h"] > 0
        assert s["confidence"] == 0.9
        assert set(s) >= {"t", "x", "y", "w", "h", "confidence", "visible"}

    # Samples stay in time order and segment-scoped.
    ts = [s["t"] for s in samples]
    assert ts == sorted(ts), "samples must be in time order"
    assert all(t <= 5.0 + 1e-6 for t in ts), "samples must be segment-scoped"

"""Anchor-pick IoU floor: a below-floor pick is NOT identity ground truth.

pick_track_for_anchor can fall back to a near-zero-IoU best_id (or a ReID
winner) when no candidate meets IOU_FLOOR_DEFAULT. Pre-fix, ANY non-None
pick set anchor_bound=True, which relaxes the edge-pinned arm of
_is_degenerate_box — so a garbage low-IoU "anchor bind" bypassed the safety
net that refuses the cameraman/edge-track false positive. Post-fix,
anchor_bound requires the picked box to MEET the accept floor (shared
source: bind.IOU_FLOOR_DEFAULT via _anchor_disagrees); a below-floor pick
may still bind, but under BLIND re-bind rules (edge arm active).

The legitimate portrait case (an anchor ON an edge-touching tall subject,
IoU ~1.0) must keep binding — that is the point of the original portrait
fix (commit 8cb60553)."""
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

# The fixture frame is 1920x1080. ONE track the whole clip: an edge-pinned
# tall-narrow box (x1=10 <= 0.02*1920=38.4; h=500 > 1.4*w=70) — degenerate
# under BLIND re-bind rules, acceptable under anchor-bound rules.
EDGE_XYXY = [10.0, 200.0, 60.0, 700.0]


class _EdgeTrackDetector:
    def __init__(self, classes, **_):
        self.classes = classes

    def detect(self, frame):
        d = EDGE_XYXY
        return np.array(
            [[d[0], d[1], d[2], d[3], 0.95, 0.0]], dtype=np.float32
        )

    def detect_seg(self, frame):
        return self.detect(frame), []


class _EdgeTrackAssociator:
    reid_backend = None  # ReID disabled → appearance gate passes everything

    def update(self, dets, frame):
        d = EDGE_XYXY
        return np.array(
            [[d[0], d[1], d[2], d[3], 5, 0.95, 0.0, 0.0]], dtype=np.float32
        )

    def reset(self):
        pass


def _run(anchors, monkeypatch, capsys):
    monkeypatch.setattr(
        pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}]
    )
    monkeypatch.setattr(pipeline, "Detector", _EdgeTrackDetector)
    monkeypatch.setattr(
        pipeline, "Associator", lambda *a, **k: _EdgeTrackAssociator()
    )
    job = {
        "videoPath": FIX,
        "fps": 5,
        "range": {"start": 0.0, "end": 5.0},
        "method": "yoloe+botsort",
        "classes": ["person"],
        "anchors": anchors,
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
    return res["samples"]


def test_below_floor_anchor_pick_does_not_bypass_edge_veto(
    monkeypatch, capsys
):
    # Anchor far from the only track (IoU 0): the pick falls back to
    # best_id, which is BELOW the accept floor → NOT anchor_bound → the
    # edge-pinned degenerate veto refuses the bind → honestly lost.
    samples = _run(
        [{"time": 0.2, "bbox": [1400.0, 300.0, 200.0, 300.0]}],
        monkeypatch,
        capsys,
    )
    assert not any(s["visible"] for s in samples), (
        "a below-floor anchor pick must not be treated as identity ground "
        "truth — the edge-pinned track must stay refused (honestly lost)"
    )


def test_at_or_above_floor_anchor_pick_still_binds_edge_subject(
    monkeypatch, capsys
):
    # PORTRAIT-FIX REGRESSION LOCK: an anchor ON the edge-touching subject
    # (IoU ~1.0 >= floor) is ground truth → edge arm relaxed → binds.
    samples = _run(
        [{"time": 0.2, "bbox": [10.0, 200.0, 50.0, 500.0]}],
        monkeypatch,
        capsys,
    )
    vis = [s for s in samples if s["visible"]]
    assert vis, "an at/above-floor anchor pick on the edge subject must bind"
    for s in vis:
        assert abs(s["x"] - EDGE_XYXY[0]) < 40.0

"""T8 follow-up: the anchor-veto diagnostic counter must also count the
anchor RE-VALIDATION site's degenerate refusal (pipeline.py, the
`_is_degenerate_box(rb, ..., anchor_bound=True)` check inside the
revalidation block) — not just the anchor-pick site. Pre-fix, a
re-validation window silently refused as degenerate left no diagnostic
trace; post-fix it is counted and summarized in the same log line.

Bind BEHAVIOR is unchanged — this is diagnostics only."""
import json
import logging
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

# 1920x1080 fixture frame.
DECOY_XYXY = [120.0, 220.0, 240.0, 460.0]  # normal box — binds first
# w=1650 >= 0.82*1920=1574.4 → degenerate even with anchor_bound=True
# (anchor_bound relaxes ONLY the edge arm, never oversize).
OVERSIZED_XYXY = [50.0, 50.0, 1700.0, 950.0]


class _TwoTrackDetector:
    def __init__(self, classes, **_):
        self.classes = classes

    def detect(self, frame):
        d, o = DECOY_XYXY, OVERSIZED_XYXY
        return np.array(
            [
                [d[0], d[1], d[2], d[3], 0.95, 0.0],
                [o[0], o[1], o[2], o[3], 0.95, 0.0],
            ],
            dtype=np.float32,
        )

    def detect_seg(self, frame):
        return self.detect(frame), []


class _TwoTrackAssociator:
    reid_backend = None

    def update(self, dets, frame):
        d, o = DECOY_XYXY, OVERSIZED_XYXY
        return np.array(
            [
                [d[0], d[1], d[2], d[3], 9, 0.95, 0.0, 0.0],
                [o[0], o[1], o[2], o[3], 1, 0.95, 0.0, 1.0],
            ],
            dtype=np.float32,
        )

    def reset(self):
        pass


def test_revalidation_degenerate_refusal_is_counted(
    monkeypatch, capsys, caplog
):
    monkeypatch.setattr(
        pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}]
    )
    monkeypatch.setattr(pipeline, "Detector", _TwoTrackDetector)
    monkeypatch.setattr(
        pipeline, "Associator", lambda *a, **k: _TwoTrackAssociator()
    )

    # Anchor #1 ON the decoy → binds id 9 (IoU ~1, legit anchor_bound).
    # Anchor #2 overlaps ONLY the oversized id 1 (IoU ≈ 0.108 >= floor 0.1;
    # decoy IoU 0) → re-validation proposes id 1 → degenerate (oversize arm,
    # anchor_bound=True) → refused. Pre-fix: refusal uncounted, no log.
    job = {
        "videoPath": FIX,
        "fps": 5,
        "range": {"start": 0.0, "end": 5.0},
        "method": "yoloe+botsort",
        "classes": ["person"],
        "anchors": [
            {"time": 0.2, "bbox": [120.0, 220.0, 120.0, 240.0]},
            {"time": 3.6, "bbox": [700.0, 300.0, 400.0, 400.0]},
        ],
        "exemplarPath": None,
    }
    with caplog.at_level(logging.INFO, logger="libitrack.pipeline"):
        rc = run_segment(job)
    assert rc == 0

    # The refusal is DIAGNOSED (counter includes the re-validation site) …
    assert any(
        "refused as degenerate" in r.getMessage() for r in caplog.records
    ), "revalidation degenerate refusal must be counted + logged"

    # … and bind BEHAVIOR is unchanged: still the decoy, never the
    # oversized box.
    lines = [
        json.loads(l)
        for l in capsys.readouterr().out.strip().splitlines()
        if l.strip()
    ]
    samples = [l for l in lines if l["type"] == "result"][-1]["samples"]
    late = [s for s in samples if s["visible"] and s["t"] > 4.0]
    assert late, "expected visible samples late (still bound to the decoy)"
    for s in late:
        assert abs(s["x"] - DECOY_XYXY[0]) < 30.0

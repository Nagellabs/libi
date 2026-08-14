"""Tests for the ``ground`` method branch in ``run_segment``.

Stage-0 grounding (set-of-marks): the sidecar runs the detector on one frame
at a given timestamp and returns NUMBERED candidate boxes so the caller can
pick the target without hand-guessing pixel coordinates.
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


def test_run_segment_ground_mode_emits_candidates_and_empty_samples(capsys):
    job = {
        "videoPath": FIX,
        "fps": 1,
        "range": {"start": 1.0, "end": 1.001},
        "method": "ground",
        "classes": ["person", "face"],
        "anchors": [{"time": 1.0, "bbox": [0, 0, 1, 1]}],
        "exemplarPath": None,
    }
    rc = run_segment(job)
    assert rc == 0

    out = capsys.readouterr().out
    lines = [json.loads(l) for l in out.strip().splitlines() if l.strip()]
    res = [l for l in lines if l["type"] == "result"][-1]

    # Must carry a ``candidates`` list (may be empty if model finds nothing).
    assert "candidates" in res
    assert isinstance(res["candidates"], list)

    # Samples must be empty for a ground-mode run.
    assert res["samples"] == []

    # Validate item shape when detections are present.
    for item in res["candidates"]:
        assert isinstance(item["index"], int)
        assert isinstance(item["bbox"], list) and len(item["bbox"]) == 4
        for v in item["bbox"]:
            assert isinstance(v, (int, float))
        assert isinstance(item["label"], str)
        assert isinstance(item["conf"], float)

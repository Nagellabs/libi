import json, pathlib
import pytest
from libitrack.pipeline import run_segment

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)

REPO = pathlib.Path(__file__).resolve().parents[4]
FIX = str(REPO / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4")


def test_run_segment_emits_progress_then_result(capsys):
    job = {
        "videoPath": FIX, "fps": 5,
        "range": {"start": 0.0, "end": 1.0},
        "method": "yoloe+botsort",
        "classes": ["person", "face"],
        "anchors": [{"time": 0.0, "bbox": [40, 40, 120, 160]}],
        "exemplarPath": None,
    }
    rc = run_segment(job)
    assert rc == 0
    lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
    assert any(l["type"] == "progress" for l in lines)
    res = [l for l in lines if l["type"] == "result"][-1]
    assert "samples" in res and "framerate" in res
    for smp in res["samples"]:
        assert set(smp) >= {"t", "x", "y", "w", "h", "confidence", "visible"}
        assert smp["t"] <= 1.0 + 1e-6  # segment-scoped

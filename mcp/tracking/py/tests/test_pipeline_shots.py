import json, pathlib
import pytest
from libitrack.pipeline import run_segment

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)

REPO = pathlib.Path(__file__).resolve().parents[4]
FIX = str(REPO / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4")


def test_run_segment_shots_mode_emits_shots_and_empty_samples(capsys):
    job = {
        "videoPath": FIX,
        "fps": 5,
        "method": "shots",
    }
    rc = run_segment(job)
    assert rc == 0
    lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
    res = [l for l in lines if l["type"] == "result"][-1]
    assert "shots" in res
    assert isinstance(res["shots"], list)
    assert len(res["shots"]) >= 1
    for shot in res["shots"]:
        assert set(shot) >= {"start", "end"}
    assert res["samples"] == []

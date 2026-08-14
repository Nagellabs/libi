# mcp/tracking/py/tests/test_shots.py
import pathlib

import pytest

from libitrack.shots import detect_shots

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

# Fail loudly (well, skip loudly) if the fixture is missing -- this test MUST
# run the real 5s clip through the model, not fall through to the empty-video
# path.
pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)

# Repo root is parents[4] from this file:
#   tests -> py -> tracking -> mcp -> <repo root>
# (The plan skeleton used parents[3], which points at .../mcp and silently
# misses the fixture, making the model/video never load. parents[4] is the
# real repo root so this test genuinely exercises TransNetV2 on the fixture.)
FIX = pathlib.Path(__file__).resolve().parents[4] / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4"


def test_detect_shots_returns_ranges_covering_video():
    shots = detect_shots(str(FIX))
    assert len(shots) >= 1
    assert shots[0]["start"] == 0.0
    for s in shots:
        assert s["end"] >= s["start"]
    # contiguous, non-overlapping
    for a, b in zip(shots, shots[1:]):
        assert b["start"] >= a["end"]

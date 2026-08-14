import numpy as np, pathlib, cv2
import pytest
from libitrack.sot import SotTracker

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)

REPO = pathlib.Path(__file__).resolve().parents[4]
FIX = REPO / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4"

def test_sot_follows_seed_box_for_a_few_frames():
    cap = cv2.VideoCapture(str(FIX)); ok, f0 = cap.read(); assert ok
    h, w = f0.shape[:2]
    seed = [w // 2 - 40, h // 2 - 40, 80, 80]  # xywh
    t = SotTracker(f0, seed)
    assert t.ok is True  # VitTrack model present → tracker active
    boxes = []
    for _ in range(5):
        ok2, fr = cap.read()
        if not ok2: break
        boxes.append(t.track(fr))  # xywh list or None
    cap.release()
    assert any(b is not None for b in boxes)
    for b in [b for b in boxes if b]:
        assert b[2] > 0 and b[3] > 0

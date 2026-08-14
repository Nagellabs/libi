# mcp/tracking/py/tests/test_pipeline_target_sim.py
import contextlib
import io
import json
import pathlib

import numpy as np
import pytest

from libitrack import pipeline

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)

REPO = pathlib.Path(__file__).resolve().parents[4]
FIX = str(REPO / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4")
LISA = [50.0, 200.0, 90.0, 130.0]


class _Backend:
    def get_features(self, xyxys, img):
        # Constant unit vector ⇒ the bound box is always perfectly similar
        # to the captured template ⇒ targetSim ≈ 1.0 on visible frames.
        n = np.asarray(xyxys, dtype=np.float32).reshape(-1, 4).shape[0]
        v = np.zeros((n, 8), dtype=np.float32)
        v[:, 0] = 1.0
        return v


class _Det:
    def __init__(self, classes, **_):
        pass

    def detect(self, frame):
        x, y, w, h = LISA
        return np.array([[x, y, x + w, y + h, 0.95, 0.0]], dtype=np.float32)

    def detect_seg(self, frame):
        return self.detect(frame), []


class _Assoc:
    def __init__(self, **_):
        self.reid_backend = _Backend()

    def update(self, dets, frame):
        x1, y1, x2, y2 = dets[0][:4]
        return np.array([[x1, y1, x2, y2, 1, 0.95, 0.0, 0.0]], dtype=np.float32)

    def reset(self):
        pass


def test_visible_samples_carry_targetsim(monkeypatch):
    monkeypatch.setattr(pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}])
    monkeypatch.setattr(pipeline, "Detector", _Det)
    monkeypatch.setattr(pipeline, "Associator", lambda *a, **k: _Assoc())
    job = {
        "videoPath": FIX, "fps": 25.0, "range": {"start": 0.0, "end": 5.0},
        "method": "yoloe+botsort", "classes": ["person"],
        "anchors": [{"time": 0.0, "bbox": LISA}],
    }
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        pipeline.run_segment(job)
    lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    samples = [l for l in lines if l["type"] == "result"][-1]["samples"]
    assert all("targetSim" in s for s in samples)
    vis = [s for s in samples if s["visible"]]
    assert vis, "expected visible samples"
    assert all(s["targetSim"] is not None for s in vis)
    assert all(s["targetSim"] > 0.9 for s in vis)  # constant backend ⇒ ≈1


def test_motion_only_targetsim_is_null(monkeypatch):
    class _NoReid(_Assoc):
        def __init__(self, **_):
            self.reid_backend = None

    monkeypatch.setattr(pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}])
    monkeypatch.setattr(pipeline, "Detector", _Det)
    monkeypatch.setattr(pipeline, "Associator", lambda *a, **k: _NoReid())
    job = {
        "videoPath": FIX, "fps": 25.0, "range": {"start": 0.0, "end": 5.0},
        "method": "yoloe+botsort", "classes": ["person"],
        "anchors": [{"time": 0.0, "bbox": LISA}],
    }
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        pipeline.run_segment(job)
    lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    samples = [l for l in lines if l["type"] == "result"][-1]["samples"]
    assert all("targetSim" in s for s in samples)
    assert all(s["targetSim"] is None for s in samples)

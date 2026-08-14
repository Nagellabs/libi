# mcp/tracking/py/tests/test_pipeline_router_seam.py
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
PERSON = [50.0, 200.0, 90.0, 130.0]


class _FrozenDet:
    def __init__(self, classes, **_): pass
    def detect(self, f):
        x, y, w, h = PERSON
        return np.array([[x, y, x + w, y + h, 0.95, 0.0]], np.float32)
    def detect_seg(self, f): return self.detect(f), []


class _Assoc:
    def __init__(self, **_): self.reid_backend = None
    def update(self, dets, frame):
        x1, y1, x2, y2 = dets[0][:4]
        return np.array([[x1, y1, x2, y2, 1, 0.95, 0.0, 0.0]], np.float32)
    def reset(self): pass


def test_person_uses_frozen_via_router(monkeypatch):
    seen = {"frozen": 0}
    def _frozen(classes):
        seen["frozen"] += 1
        return _FrozenDet(classes)
    monkeypatch.setattr(pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}])
    monkeypatch.setattr(pipeline, "Associator", lambda *a, **k: _Assoc())
    monkeypatch.setattr(pipeline, "_FROZEN_FACTORY", _frozen)
    job = {"videoPath": FIX, "fps": 25.0, "range": {"start": 0.0, "end": 5.0},
           "method": "yoloe+botsort", "classes": ["person"],
           "anchors": [{"time": 0.0, "bbox": PERSON}]}
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        pipeline.run_segment(job)
    lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    samples = [l for l in lines if l["type"] == "result"][-1]["samples"]
    assert seen["frozen"] >= 1
    assert any(s["visible"] for s in samples)


def test_novel_class_uses_eager_via_router(monkeypatch):
    seen = {"eager": 0}
    class _EagerDet(_FrozenDet):
        def __init__(self, *a, **k): seen["eager"] += 1
    monkeypatch.setattr(pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}])
    monkeypatch.setattr(pipeline, "Associator", lambda *a, **k: _Assoc())
    monkeypatch.setattr(pipeline, "_EAGER_FACTORY", lambda **k: _EagerDet())
    job = {"videoPath": FIX, "fps": 25.0, "range": {"start": 0.0, "end": 5.0},
           "method": "yoloe+botsort", "classes": ["backpack"],
           "anchors": [{"time": 0.0, "bbox": PERSON}]}
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        pipeline.run_segment(job)
    assert seen["eager"] >= 1
    lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    result = [l for l in lines if l["type"] == "result"]
    assert result, "run_segment produced no result line via the eager seam"

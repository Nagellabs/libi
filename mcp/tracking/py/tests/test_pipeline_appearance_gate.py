# mcp/tracking/py/tests/test_pipeline_appearance_gate.py
import json

import numpy as np
import pytest

from libitrack import pipeline

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)

FPS = 25.0
LISA = (50.0, 200.0, 90.0, 130.0)        # xywh, h=130 → "A" appearance
CAM = (40.0, 180.0, 100.0, 200.0)        # xywh, h=200, overlaps LISA → "B"


class _Backend:
    """Appearance keyed on box height: h<160 → A subject, else B subject."""

    def get_features(self, xyxys, img):
        out = []
        for b in np.asarray(xyxys, dtype=np.float32).reshape(-1, 4):
            h = b[3] - b[1]
            v = np.zeros(8, dtype=np.float32)
            v[0 if h < 160 else 4] = 1.0
            out.append(v)
        return np.asarray(out, dtype=np.float32)


def _xyxy(box):
    x, y, w, h = box
    return [x, y, x + w, y + h]


class _Detector:
    """Lisa visible near the anchors (t<0.4 and t>3.6); ONLY the cameraman
    in between (the historical wrong-bind window)."""

    def __init__(self, classes, **_):
        pass

    def detect(self, frame):
        return self._d(getattr(self, "_t", 0.0))

    def detect_seg(self, frame):
        return self.detect(frame), []

    def _d(self, t):
        if t < 0.4 or t > 3.6:
            x1, y1, x2, y2 = _xyxy(LISA)
        else:
            x1, y1, x2, y2 = _xyxy(CAM)
        return np.array([[x1, y1, x2, y2, 0.95, 0.0]], dtype=np.float32)


class _Assoc:
    """Pass detection through; flip the BoxMOT id mid-clip so the engine's
    re-bind branch fires and only the cameraman is on offer there."""

    def __init__(self, **_):
        self.reid_backend = _Backend()
        self._n = 0

    def update(self, dets, frame):
        self._n += 1
        tid = 1 if self._n <= 10 else 2
        x1, y1, x2, y2 = dets[0][:4]
        return np.array(
            [[x1, y1, x2, y2, tid, 0.95, 0.0, 0.0]], dtype=np.float32
        )

    def reset(self):
        self._n = 0


def _run(monkeypatch, tmp_path):
    # Drive the Detector with the current timestamp.
    det = _Detector(["person"])

    class _DetWrap(_Detector):
        def __init__(self, classes, **_):
            super().__init__(classes)

        def detect(self, frame):
            return self._d(_DetWrap.t)

    monkeypatch.setattr(pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}])

    # A Detector whose timestamp is advanced by a patched cv2 read is heavy;
    # instead patch run_segment's frame timing indirectly: use the real
    # fixture clip for frames and a time-aware detector.
    import pathlib

    repo = pathlib.Path(__file__).resolve().parents[4]
    fix = str(repo / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4")

    state = {"t": 0.0}

    class _TimeDet(_Detector):
        def __init__(self, classes, **_):
            super().__init__(classes)

        def detect(self, frame):
            return self._d(state["t"])

    real_run = pipeline.run_segment

    # Wrap cap.read via a counter is complex; rely on the detector seeing the
    # frame index through a monkeypatched _emit-free path: advance state["t"]
    # from the progress hook is unavailable. Use fps math: the pipeline reads
    # every (src_fps/fps) frame; map processed-frame count to time.
    orig_flush = pipeline._flush_shot
    seen = {"k": 0}

    def _flush(buf, binds, samples):
        return orig_flush(buf, binds, samples)

    monkeypatch.setattr(pipeline, "Detector", _TimeDet)
    monkeypatch.setattr(pipeline, "Associator", lambda *a, **k: _Assoc())

    # Advance the detector clock as frames are appended to shot_buf.
    real_append_target = None

    job = {
        "videoPath": fix,
        "fps": FPS,
        "range": {"start": 0.0, "end": 5.0},
        "method": "yoloe+botsort",
        "classes": ["person"],
        "anchors": [
            {"time": 0.0, "bbox": list(LISA)},
            {"time": 4.0, "bbox": list(LISA)},
        ],
    }

    # Tie detector time to the source frame index: the fixture is 25 fps,
    # fps==25 so step==1 and processed frame i ⇒ t = i/25. Patch list.append
    # is brittle; instead derive time inside _TimeDet from a frame counter.
    counter = {"n": -1}

    class _CountDet(_Detector):
        def __init__(self, classes, **_):
            super().__init__(classes)

        def detect(self, frame):
            counter["n"] += 1
            return self._d(counter["n"] / 25.0)

        def detect_seg(self, frame):
            return self.detect(frame), []

    monkeypatch.setattr(pipeline, "Detector", _CountDet)

    import io
    import contextlib

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        real_run(job)
    lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    res = [l for l in lines if l["type"] == "result"][-1]
    return res["samples"]


def test_gate_rejects_dissimilar_cameraman_between_anchors(monkeypatch, tmp_path):
    samples = _run(monkeypatch, tmp_path)
    mid = [s for s in samples if 1.0 <= s["t"] <= 3.0]
    assert mid, "expected samples in the between-anchor window"
    # The only candidate there is the cameraman (B). The gate must reject
    # him → honest miss (visible:false), NOT a confident wrong-subject bind.
    assert all(s["visible"] is False for s in mid), (
        "cameraman was bound despite failing the appearance gate: "
        f"{[ (s['t'], s['visible']) for s in mid[:5] ]}"
    )


def test_gate_allows_similar_subject_near_anchor(monkeypatch, tmp_path):
    samples = _run(monkeypatch, tmp_path)
    near = [s for s in samples if s["t"] <= 0.3]
    assert any(s["visible"] for s in near), (
        "Lisa (similar to the anchor template) must still bind near the anchor"
    )

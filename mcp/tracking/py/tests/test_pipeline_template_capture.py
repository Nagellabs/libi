# mcp/tracking/py/tests/test_pipeline_template_capture.py
import numpy as np

from libitrack.pipeline import _capture_anchor_template
from libitrack.target import TargetTemplate


class _FakeReid:
    """box x<200 → 'A' subject vector; x>=200 → 'B' subject vector."""

    enabled = True

    def get_features(self, frame, boxes):
        out = []
        for b in boxes:
            v = np.zeros(8, dtype=np.float32)
            v[0 if b[0] < 200 else 4] = 1.0
            out.append(v)
        return np.asarray(out, dtype=np.float32)


class _OffReid:
    enabled = False

    def get_features(self, frame, boxes):  # pragma: no cover - never called
        raise AssertionError("must not be called when disabled")


def test_capture_adds_bound_and_anchor_embeddings():
    t = TargetTemplate()
    frame = np.zeros((64, 64, 3), dtype=np.uint8)
    _capture_anchor_template(
        _FakeReid(), t, frame, [10, 10, 50, 80], [12, 12, 52, 82]
    )
    assert len(t) == 2
    aq = np.zeros(8, dtype=np.float32); aq[0] = 1.0   # A-like
    bq = np.zeros(8, dtype=np.float32); bq[4] = 1.0   # B-like
    assert t.similarity(aq) > 0.99
    assert t.similarity(bq) < 0.5


def test_capture_noop_when_disabled():
    t = TargetTemplate()
    _capture_anchor_template(_OffReid(), t, None, [0, 0, 1, 1], None)
    assert t.empty


def test_capture_handles_missing_anchor_box():
    t = TargetTemplate()
    frame = np.zeros((8, 8, 3), dtype=np.uint8)
    _capture_anchor_template(_FakeReid(), t, frame, [10, 10, 50, 80], None)
    assert len(t) == 1

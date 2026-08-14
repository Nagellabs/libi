# mcp/tracking/py/tests/test_reid_features.py
import numpy as np

from libitrack.reid_features import ReidFeatures, cosine


class _FakeBackend:
    """Deterministic stand-in for boxmot's ReID backend: a box's embedding
    is keyed by its top-left x so the same box → identical vector and a
    different box → a different vector. No network, no model."""

    def get_features(self, xyxys, img):
        out = []
        for b in np.asarray(xyxys, dtype=np.float32).reshape(-1, 4):
            seed = int(b[0]) % 7
            v = np.zeros(8, dtype=np.float32)
            v[seed] = 1.0
            v[(seed + 1) % 8] = 0.25
            out.append(v)
        return np.asarray(out, dtype=np.float32)


def test_cosine_identity_orthogonal_and_degenerate():
    v = np.array([1.0, 2.0, 3.0], dtype=np.float32)
    assert abs(cosine(v, v) - 1.0) < 1e-6
    a = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    b = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    assert abs(cosine(a, b)) < 1e-6
    assert cosine(np.zeros(3, np.float32), v) == 0.0


def test_get_features_shape_and_similarity():
    rf = ReidFeatures(_FakeBackend())
    assert rf.enabled is True
    frame = np.zeros((64, 64, 3), dtype=np.uint8)
    f = rf.get_features(frame, [[10, 10, 30, 40]])
    assert f is not None and f.ndim == 2 and f.shape[0] == 1
    g = rf.get_features(frame, [[10, 10, 30, 40]])
    assert cosine(f[0], g[0]) > 0.99          # same box → ≈1
    h = rf.get_features(frame, [[300, 10, 320, 40]])
    assert cosine(f[0], h[0]) < 0.9           # different box → lower


def test_disabled_backend_is_noop():
    rf = ReidFeatures(None)
    assert rf.enabled is False
    assert rf.get_features(np.zeros((4, 4, 3), np.uint8), [[0, 0, 1, 1]]) is None


def test_no_boxes_returns_none():
    rf = ReidFeatures(_FakeBackend())
    assert rf.get_features(np.zeros((4, 4, 3), np.uint8), []) is None

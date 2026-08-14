# mcp/tracking/py/libitrack/reid_features.py
"""Shared OSNet ReID feature extraction over the SAME boxmot backend the
Associator built. Never loads a second model. Every method is a safe no-op
when the backend is None so the motion-only fallback path stays correct."""
from __future__ import annotations

import numpy as np


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity of two 1-D vectors. 0.0 if either is degenerate."""
    a = np.asarray(a, dtype=np.float32).ravel()
    b = np.asarray(b, dtype=np.float32).ravel()
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


class ReidFeatures:
    """Thin wrapper over boxmot's ReID backend. ``backend`` is the object
    returned by ``boxmot.reid.ReID(...).model`` — it exposes
    ``get_features(xyxys, img)`` -> (N, D) float array (see SPIKE-NOTES
    "ReID feature API for appearance-gating"). ``backend=None`` ⇒ disabled."""

    def __init__(self, backend) -> None:
        self.backend = backend

    @property
    def enabled(self) -> bool:
        return self.backend is not None

    def get_features(self, frame, boxes_xyxy):
        """(N, D) float32 embeddings for xyxy ``boxes_xyxy`` on ``frame``
        (raw BGR HxWx3), or None when disabled / no boxes."""
        if self.backend is None:
            return None
        boxes = np.asarray(boxes_xyxy, dtype=np.float32)
        if boxes.size == 0:
            return None
        boxes = np.ascontiguousarray(boxes.reshape(-1, 4))
        feats = self.backend.get_features(boxes, frame)
        return np.asarray(feats, dtype=np.float32)

# mcp/tracking/py/libitrack/target.py
"""Appearance memory of the anchored subject — a tiny ring of OSNet
embeddings captured at/after the anchor bind. The gate compares against the
MAX cosine over the ring so a pose change (front→back) doesn't sink it."""
from __future__ import annotations

import numpy as np

from libitrack.reid_features import cosine


class TargetTemplate:
    def __init__(self, maxlen: int = 4) -> None:
        self._maxlen = max(1, int(maxlen))
        self._ring: list[np.ndarray] = []

    def __len__(self) -> int:
        return len(self._ring)

    @property
    def empty(self) -> bool:
        return not self._ring

    def add(self, emb: np.ndarray | None) -> None:
        if emb is None:
            return
        v = np.asarray(emb, dtype=np.float32).ravel()
        if v.size == 0 or float(np.linalg.norm(v)) == 0.0:
            return
        self._ring.append(v)
        if len(self._ring) > self._maxlen:
            self._ring.pop(0)  # evict oldest

    def similarity(self, q: np.ndarray | None) -> float | None:
        """Max cosine of q against the ring, or None when the ring is empty
        (gate disabled — callers MUST treat None as 'no opinion → allow')."""
        if not self._ring or q is None:
            return None
        qv = np.asarray(q, dtype=np.float32).ravel()
        return max(cosine(qv, e) for e in self._ring)

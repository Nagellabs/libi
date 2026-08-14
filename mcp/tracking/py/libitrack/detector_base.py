# mcp/tracking/py/libitrack/detector_base.py
"""The detector contract both backends satisfy.

Nx6 = [x1, y1, x2, y2, conf, cls] in source-frame pixels (matches the frozen
ONNX `Detector`). `detect_seg` adds a per-detection full-frame bool mask.
Family A must keep this contract identical so `pipeline.py` downstream
(associate / bind / B+C / smooth / head-refine) is backend-agnostic."""
from __future__ import annotations

from typing import Protocol, runtime_checkable

import numpy as np

# Single source of truth for the pipeline's detection-confidence floor.
# BOTH detector backends emit detections at conf >= this floor, and the
# associator (libitrack/associate.py) MUST NOT gate track birth stricter
# than it: BoxMOT's stock BotSort defaults (track_high_thresh=0.5,
# new_track_thresh=0.6) silently discarded every detection in
# [CONF_FLOOR_DEFAULT, 0.5) — on ordinary low-res footage (e.g. 320x240,
# person conf ~0.26-0.43) the detector saw the subject on every frame yet
# NO track was ever born, producing an all-invisible track (task-39 Bug 1).
# Backend-agnostic on purpose: whichever backend produces the confidence,
# a [floor, track_high) dead band between detector and associator is the
# bug; sharing one constant makes it structurally impossible.
CONF_FLOOR_DEFAULT = 0.25


@runtime_checkable
class DetectorProtocol(Protocol):
    def detect(self, frame: np.ndarray) -> np.ndarray:
        """(N,6) float32 [x1,y1,x2,y2,conf,cls]; (0,6) when none."""
        ...

    def detect_seg(
        self, frame: np.ndarray
    ) -> tuple[np.ndarray, list[np.ndarray]]:
        """((N,6) float32, list[bool HxW]); ((0,6), []) when none."""
        ...

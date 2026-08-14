# mcp/tracking/py/libitrack/detect_yoloe_vp.py
"""Eager YOLOE visual-prompt detector backend (lazy, fallback for novel
classes). The prompt is encoded ONCE from the anchor crop+box, then detection
runs per frame. Output is mapped onto the SAME Nx6/(Nx6,masks) contract as the
frozen ONNX Detector so pipeline.py is backend-agnostic. ultralytics is
imported lazily inside _RealPredictor so this module imports cleanly without
the dep (the router only constructs a real predictor on the non-frozen path)."""
from __future__ import annotations

import numpy as np

from libitrack.detector_base import CONF_FLOOR_DEFAULT, DetectorProtocol


def _boxes_to_nx6(boxes) -> np.ndarray:
    if boxes is None:
        return np.zeros((0, 6), np.float32)
    xyxy = np.asarray(boxes.xyxy.cpu().numpy(), np.float32).reshape(-1, 4)
    if xyxy.shape[0] == 0:
        return np.zeros((0, 6), np.float32)
    conf = np.asarray(boxes.conf.cpu().numpy(), np.float32).reshape(-1, 1)
    cls = np.asarray(boxes.cls.cpu().numpy(), np.float32).reshape(-1, 1)
    return np.concatenate([xyxy, conf, cls], axis=1).astype(np.float32)


def _masks_to_bool(masks, h: int, w: int, n: int) -> list[np.ndarray]:
    if masks is None:
        return []
    import cv2

    data = np.asarray(masks.data.cpu().numpy(), np.float32)
    out: list[np.ndarray] = []
    for i in range(min(n, data.shape[0])):
        m = cv2.resize(data[i], (w, h), interpolation=cv2.INTER_LINEAR)
        out.append(m > 0.5)
    return out


class _RealPredictor:
    """The ONLY ultralytics-touching code. __init__/set_prompt/infer bodies
    are transcribed VERBATIM from mcp/tracking/py/SPIKE-NOTES-yoloe-vp.md
    '## Predictor API' (the YOLOEVPSegPredictor two-stage cross-image form).
    Do NOT use YOLOEVPDetectPredictor — the spike proved it crashes on the
    seg model."""

    def __init__(self) -> None:
        # Lazy-import ultralytics here; model is loaded in set_prompt once we
        # have the model path. Store m=None until set_prompt is called.
        from ultralytics import YOLOE
        from ultralytics.utils import SETTINGS

        SETTINGS.update({"sync": False})  # disable analytics — no network calls during predict

        from libitrack.models import model_path

        self._m = YOLOE(model_path("yoloe-11s-seg.pt"), verbose=False)

    def set_prompt(self, anchor_crop, anchor_box_xyxy, classes) -> None:
        # --- Stage 1: Encode anchor once (one-time cost per object) ---
        # From SPIKE-NOTES §Predictor API: STAGE 1 (encode once).
        from ultralytics.models.yolo.yoloe.predict import YOLOEVPSegPredictor

        m = self._m
        prompts = {
            "bboxes": np.array([anchor_box_xyxy], dtype=np.float32),  # shape (1, 4)
            "cls": np.array([0]),                                       # shape (1,)
        }
        predictor = YOLOEVPSegPredictor(
            overrides={
                "task": m.model.task,   # "segment"
                "mode": "predict",
                "save": False,
                "verbose": False,
                "batch": 1,
                "imgsz": 640,
            },
            _callbacks=m.callbacks,
        )
        m.model.model[-1].nc = 1
        m.model.names = ["object0"]
        predictor.set_prompts(prompts.copy())
        predictor.setup_model(model=m.model)
        vpe = predictor.get_vpe(anchor_crop)       # encodes anchor → VPE tensor shape (1, 1, 512)
        m.model.set_classes(m.model.names, vpe)    # burns VPE into model head
        m.task = "segment"
        m.predictor = None                         # reset so subsequent predict() uses burned-in VPE

    def infer(self, frame, want_mask: bool):
        # The seg model always returns masks; want_mask is informational
        # (mirrors the injectable predictor interface). detect() discards r.masks.
        # --- Stage 2: Detect on any subsequent frame (fast, no re-encoding) ---
        # From SPIKE-NOTES §Predictor API: STAGE 2 (detect, reuses burned-in VPE).
        res = self._m.predict(frame, conf=CONF_FLOOR_DEFAULT, verbose=False)
        return res[0]


class YoloeVpDetector(DetectorProtocol):
    def __init__(
        self,
        anchor_crop: np.ndarray,
        anchor_box_xyxy: list[float],
        classes: list[str],
        _predictor=None,
    ) -> None:
        self._classes = classes
        self._p = _predictor if _predictor is not None else _RealPredictor()
        self._p.set_prompt(anchor_crop, anchor_box_xyxy, classes)

    def detect(self, frame: np.ndarray) -> np.ndarray:
        r = self._p.infer(frame, want_mask=False)
        return _boxes_to_nx6(getattr(r, "boxes", None))

    def detect_seg(
        self, frame: np.ndarray
    ) -> tuple[np.ndarray, list[np.ndarray]]:
        r = self._p.infer(frame, want_mask=True)
        dets = _boxes_to_nx6(getattr(r, "boxes", None))
        if dets.shape[0] == 0:
            return np.zeros((0, 6), np.float32), []
        h, w = frame.shape[:2]
        masks = _masks_to_bool(getattr(r, "masks", None), h, w, dets.shape[0])
        return dets, masks

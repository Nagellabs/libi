"""YOLOE-11s seg ONNX detector.

Model contract (verified, see SPIKE-NOTES.md):
  input  ``images``   shape ``[1, 3, 640, 640]``         dtype ``tensor(float)``  (NCHW, RGB, 0..1)
  output ``output0``  shape ``[1, 4+nc+32, 8400]``       dtype ``tensor(float)``
  output ``output1``  shape ``[1, 32, 160, 160]``        dtype ``tensor(float)``  (mask protos -- IGNORED)

CRITICAL: output0's channel count = 4 + nc + 32 (it's a -seg model; last 32
channels are mask coefficients that must be stripped before class decoding).
nc = output0.shape[1] - 4 - 32 -- do NOT hardcode nc or assume shape[1]-4.
"""
import cv2
import numpy as np
import onnxruntime as ort

from libitrack.detector_base import CONF_FLOOR_DEFAULT, DetectorProtocol
from libitrack.models import model_path


class Detector(DetectorProtocol):
    """Wraps the YOLOE-11s seg ONNX model for open-vocabulary detection.

    Args:
        classes: List of class names the model was exported with (e.g. ["person"]).
        conf:    Confidence threshold for filtering detections (default 0.25).
        iou:     IoU threshold for NMS (default 0.5).
        model:   Filename of the ONNX model in the tracking models dir (default "yoloe11.onnx").
    """

    def __init__(
        self,
        classes: list[str],
        conf: float = CONF_FLOOR_DEFAULT,
        iou: float = 0.5,
        model: str = "yoloe11.onnx",
    ) -> None:
        self.sess = ort.InferenceSession(
            model_path(model), providers=["CPUExecutionProvider"]
        )
        inp = self.sess.get_inputs()[0]
        self.iname = inp.name
        # input shape [1, 3, H, W]
        self.ih, self.iw = int(inp.shape[2]), int(inp.shape[3])
        self.conf = conf
        self.iou = iou
        self.classes = classes

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _pre(self, frame: np.ndarray) -> tuple[np.ndarray, float]:
        """Letterbox-resize a HxWx3 uint8 BGR/RGB frame to the model's input size.

        Returns:
            blob: float32 NCHW tensor in [0, 1], RGB channel order.
            r:    scale ratio used (same for both axes).
        """
        h, w = frame.shape[:2]
        r = min(self.iw / w, self.ih / h)
        nw, nh = int(round(w * r)), int(round(h * r))
        rz = cv2.resize(frame, (nw, nh))
        canvas = np.full((self.ih, self.iw, 3), 114, np.uint8)
        canvas[:nh, :nw] = rz
        # BGR -> RGB, HWC -> CHW, add batch dim, normalise to [0,1]
        blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        return blob, r

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(self, frame: np.ndarray) -> np.ndarray:
        """Run detection on a single frame.

        Args:
            frame: HxWx3 uint8 image (BGR or RGB -- both work after letterboxing).

        Returns:
            Float32 array of shape (N, 6) with columns [x1, y1, x2, y2, conf, cls].
            Returns shape (0, 6) when no detections pass the conf+NMS filters.
        """
        blob, r = self._pre(frame)
        # output0: [1, 4+nc+32, 8400]
        out = self.sess.run(None, {self.iname: blob})[0]
        out = np.squeeze(out, 0).T  # (8400, 4+nc+32)

        C = out.shape[1]
        # CRITICAL: strip the 32 mask-coeff channels from the channel count
        nc = C - 4 - 32  # number of classes in this model's vocabulary

        boxes: list[list[float]] = []
        scores: list[float] = []
        cls_ids: list[int] = []

        for row in out:
            class_scores = row[4 : 4 + nc]
            k = int(np.argmax(class_scores))
            sc = float(class_scores[k])
            if sc < self.conf:
                continue
            cx, cy, bw, bh = row[:4]
            # Map letterboxed coords back to original frame coords
            boxes.append(
                [
                    (cx - bw / 2) / r,
                    (cy - bh / 2) / r,
                    (cx + bw / 2) / r,
                    (cy + bh / 2) / r,
                ]
            )
            scores.append(sc)
            cls_ids.append(k)

        if not boxes:
            return np.zeros((0, 6), np.float32)

        idx = cv2.dnn.NMSBoxes(boxes, scores, self.conf, self.iou)
        idx = np.array(idx).reshape(-1)
        return np.array(
            [[*boxes[i], scores[i], cls_ids[i]] for i in idx], dtype=np.float32
        )

    def detect_seg(self, frame: np.ndarray):
        """Detection + per-detection instance MASK (YOLOE-11s-seg).

        The model is a *-seg model: ``output0``'s last 32 channels are mask
        coefficients and ``output1`` is the [1,32,160,160] prototype bank.
        ``detect`` throws those away (it only needs boxes for BoT-SORT).
        This variant assembles the binary instance mask for each kept
        detection so callers can localise *within* the box — e.g. the
        head = top of the person silhouette, which (unlike the bbox top)
        is robust to a raised arm / dance because the arm is a thin
        protrusion of the same silhouette.

        Returns:
            (dets, masks) where ``dets`` is (N,6) [x1,y1,x2,y2,conf,cls]
            (same as ``detect``) and ``masks`` is a list of N ``bool``
            arrays shaped like ``frame[:2]`` (full-frame instance masks,
            already mapped back to original pixel coords). Empty -> ([], []).
        """
        h0, w0 = frame.shape[:2]
        blob, r = self._pre(frame)
        out0, out1 = self.sess.run(None, {self.iname: blob})[:2]
        preds = np.squeeze(out0, 0).T  # (8400, 4+nc+32)
        protos = np.squeeze(out1, 0)  # (32, mh, mw)
        mc = protos.shape[0]
        mh, mw = protos.shape[1], protos.shape[2]
        C = preds.shape[1]
        nc = C - 4 - mc

        boxes: list[list[float]] = []
        scores: list[float] = []
        cls_ids: list[int] = []
        coeffs: list[np.ndarray] = []
        nw, nh = int(round(w0 * r)), int(round(h0 * r))  # real (un-padded) area
        for row in preds:
            class_scores = row[4 : 4 + nc]
            k = int(np.argmax(class_scores))
            sc = float(class_scores[k])
            if sc < self.conf:
                continue
            cx, cy, bw, bh = row[:4]
            boxes.append(
                [
                    (cx - bw / 2) / r,
                    (cy - bh / 2) / r,
                    (cx + bw / 2) / r,
                    (cy + bh / 2) / r,
                ]
            )
            scores.append(sc)
            cls_ids.append(k)
            coeffs.append(row[4 + nc : 4 + nc + mc].astype(np.float32))

        if not boxes:
            return np.zeros((0, 6), np.float32), []

        idx = cv2.dnn.NMSBoxes(boxes, scores, self.conf, self.iou)
        idx = np.array(idx).reshape(-1)

        protos_flat = protos.reshape(mc, mh * mw).astype(np.float32)
        masks: list[np.ndarray] = []
        dets: list[list[float]] = []
        for i in idx:
            dets.append([*boxes[i], scores[i], cls_ids[i]])
            m = 1.0 / (1.0 + np.exp(-(coeffs[i] @ protos_flat)))  # sigmoid
            m = m.reshape(mh, mw)
            # proto grid (mh×mw) maps to the letterboxed input (ih×iw);
            # crop to the real (un-padded) image area, then resize to the
            # original frame so mask coords == frame pixel coords.
            cw = max(1, int(round(mw * nw / self.iw)))
            ch = max(1, int(round(mh * nh / self.ih)))
            m = m[:ch, :cw]
            m = cv2.resize(m, (w0, h0), interpolation=cv2.INTER_LINEAR)
            bm = m > 0.5
            # Keep only mask pixels inside this detection's box (instance
            # isolation — protos can bleed across nearby instances).
            x1, y1, x2, y2 = boxes[i]
            ix1, iy1 = max(0, int(x1)), max(0, int(y1))
            ix2, iy2 = min(w0, int(round(x2))), min(h0, int(round(y2)))
            keep = np.zeros((h0, w0), bool)
            if ix2 > ix1 and iy2 > iy1:
                keep[iy1:iy2, ix1:ix2] = True
            masks.append(bm & keep)
        return np.array(dets, dtype=np.float32), masks

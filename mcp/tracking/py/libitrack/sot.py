"""Single-object-tracker fallback using OpenCV VitTrack.

Used when YOLOE+BoxMOT loses an object within a shot. Wraps ``cv2.TrackerVit``
with the ``sot.onnx`` ONNX model (OpenCV VitTrack "2023sep").

``SotTracker.ok`` is ``False`` if the model file is missing or the OpenCV
build does not include ``TrackerVit`` (the engine still ships in that case
on YOLOE+BoxMOT alone). Callers treat ``ok=False`` as an honestly disabled
tracker — not an error.
"""
import sys

import cv2

from libitrack.models import model_path

# VitTrack confidence score below this threshold → target considered lost.
# SPIKE-NOTES: recommended ~0.4–0.5 (matches OpenCV's internal default).
SOT_SCORE_THRESHOLD = 0.4


class SotTracker:
    """OpenCV VitTrack single-object tracker, seeded from an anchor box.

    Parameters
    ----------
    frame0:
        First frame (HxWx3 uint8 BGR, ``cv2.VideoCapture`` default).
    seed_xywh:
        Bounding box ``[x, y, w, h]`` (ints or floats) in ``frame0`` to lock
        onto.
    model:
        Filename of the ONNX relative to the tracking models directory
        (default ``"sot.onnx"``).
    """

    def __init__(self, frame0, seed_xywh, model: str = "sot.onnx"):
        self.ok = False
        try:
            params = cv2.TrackerVit_Params()
            params.net = model_path(model)
            self._t = cv2.TrackerVit_create(params)
            x, y, w, h = (int(round(v)) for v in seed_xywh)
            self._t.init(frame0, (x, y, w, h))
            self.ok = True
        except Exception as e:  # model missing / opencv build without VitTrack
            print(f"[sot] disabled: {e}", file=sys.stderr)

    def track(self, frame):
        """Track the object in the next frame.

        Parameters
        ----------
        frame:
            Current frame (HxWx3 uint8 BGR).

        Returns
        -------
        list[int] or None
            ``[x, y, w, h]`` bounding box (ints) when the object is found and
            the confidence score is above threshold, ``None`` when lost or when
            the tracker is disabled (``ok=False``).
        """
        if not self.ok:
            return None
        found, box = self._t.update(frame)
        if not found:
            return None
        try:
            if self._t.getTrackingScore() < SOT_SCORE_THRESHOLD:
                return None
        except Exception:
            pass  # older opencv may lack getTrackingScore; rely on `found`
        x, y, w, h = (int(v) for v in box)
        if w <= 0 or h <= 0:
            return None
        return [x, y, w, h]

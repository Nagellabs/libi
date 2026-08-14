# mcp/tracking/py/libitrack/detector_router.py
"""Class-aware detector router — the single new seam.

A request whose every class ∈ FROZEN_VOCAB uses the fast frozen ONNX
Detector. Any class NOT covered by a frozen model routes to the eager
YOLOE-VP backend (prompted with the anchor crop). FROZEN_VOCAB is the single
source of truth for runtime tiering; adding a frozen export adds entries here.
The eager dep ships WITH the tracking engine (provisioned by tracking-pyenv),
so a missing eager dep means a corrupt/partial install — surfaced as a plain
RuntimeError pointing at the existing libi-tracking install plan (NO new
not-installed contract; reuses the existing engine-not-installed gate)."""
from __future__ import annotations

from libitrack.detector_base import DetectorProtocol

# Classes any frozen model already covers. Today the frozen yoloe11.onnx is
# the ["person"] build; face tracking is person-detect + head-refine
# (classes stays ["person"]), so "face" is frozen too.
FROZEN_VOCAB: set[str] = {"person", "face"}


def _read_anchor_crop(video_path: str, t: float, bbox_xywh):
    """Read the frame at time `t` and crop bbox (xywh px). Returns
    (crop BGR HxWx3, anchor_box_xyxy). Raises RuntimeError on read failure."""
    # NOTE: clamp + degenerate-box logic here is intentionally not unit-tested
    # (cv2 VideoCapture I/O dependency); exercised end-to-end in Task 7's
    # real-footage eval. If a synthetic video fixture is added, test directly.
    import cv2

    cap = cv2.VideoCapture(video_path)
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            raise RuntimeError(
                f"YOLOE-VP router: could not read anchor frame at t={t}s "
                f"from {video_path}"
            )
    finally:
        cap.release()
    x, y, w, h = (float(v) for v in bbox_xywh)
    H, W = frame.shape[:2]
    ix1, iy1 = max(0, int(x)), max(0, int(y))
    ix2, iy2 = min(W, int(round(x + w))), min(H, int(round(y + h)))
    if ix2 <= ix1 or iy2 <= iy1:
        raise RuntimeError(
            f"YOLOE-VP router: degenerate anchor box {bbox_xywh} for crop"
        )
    crop = frame[iy1:iy2, ix1:ix2].copy()
    return crop, [x, y, x + w, y + h]


def select_detector(
    classes: list[str],
    anchors: list,
    job: dict,
    *,
    frozen_factory=None,
    eager_factory=None,
    _crop_reader=_read_anchor_crop,
) -> DetectorProtocol:
    """Pick the backend. `frozen_factory(classes)->DetectorProtocol` and
    `eager_factory(anchor_crop=, anchor_box_xyxy=, classes=)->DetectorProtocol`
    are injectable for hermetic tests; production defaults are bound below."""
    if frozen_factory is None:
        from libitrack.detect import Detector

        frozen_factory = lambda classes: Detector(classes=classes)  # noqa: E731
    if eager_factory is None:
        from libitrack.detect_yoloe_vp import YoloeVpDetector

        def eager_factory(*, anchor_crop, anchor_box_xyxy, classes):
            return YoloeVpDetector(anchor_crop, anchor_box_xyxy, classes)

    cls = classes or ["person"]
    if all(c in FROZEN_VOCAB for c in cls):
        return frozen_factory(cls)

    if not anchors:
        raise RuntimeError(
            "YOLOE-VP generalized detector needs an anchor (the visual "
            "prompt). Provide anchors[] for the non-person target."
        )
    a = min(anchors, key=lambda an: an.get("time", 0.0))
    crop, box_xyxy = _crop_reader(
        job.get("videoPath", ""), a.get("time", 0.0), a["bbox"]
    )
    return eager_factory(
        anchor_crop=crop, anchor_box_xyxy=box_xyxy, classes=cls
    )

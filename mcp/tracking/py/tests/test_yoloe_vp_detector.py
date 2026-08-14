# mcp/tracking/py/tests/test_yoloe_vp_detector.py
import numpy as np

from libitrack.detect_yoloe_vp import YoloeVpDetector
from libitrack.detector_base import DetectorProtocol


class _FakeResultBoxes:
    def __init__(self, xyxy, conf, cls):
        self._xyxy, self._conf, self._cls = xyxy, conf, cls
    @property
    def xyxy(self): return _T(self._xyxy)
    @property
    def conf(self): return _T(self._conf)
    @property
    def cls(self): return _T(self._cls)


class _T:  # mimics a torch tensor's .cpu().numpy()
    def __init__(self, a): self._a = np.asarray(a, np.float32)
    def cpu(self): return self
    def numpy(self): return self._a


class _FakeMasks:
    def __init__(self, data): self.data = _T(data)


class _FakeResult:
    def __init__(self, boxes, masks=None): self.boxes, self.masks = boxes, masks


class _FakePredictor:
    def __init__(self): self.prompt_calls = 0
    def set_prompt(self, anchor_crop, anchor_box_xyxy, classes):
        self.prompt_calls += 1
    def infer(self, frame, want_mask: bool):
        boxes = _FakeResultBoxes([[10, 20, 60, 120]], [0.88], [0])
        masks = _FakeMasks([np.ones((frame.shape[0], frame.shape[1]), np.float32)]) if want_mask else None
        return _FakeResult(boxes, masks)


def _det():
    return YoloeVpDetector(
        anchor_crop=np.zeros((80, 50, 3), np.uint8),
        anchor_box_xyxy=[0.0, 0.0, 50.0, 80.0],
        classes=["backpack"],
        _predictor=_FakePredictor(),
    )


def test_conforms_to_protocol():
    assert isinstance(_det(), DetectorProtocol)


def test_detect_returns_nx6():
    out = _det().detect(np.zeros((240, 320, 3), np.uint8))
    assert out.ndim == 2 and out.shape[1] == 6
    assert out[0, 4] == np.float32(0.88) and out[0, 5] == 0
    # Encode-once contract: the VPE prompt is set exactly once at construction,
    # never re-encoded per detect (the whole point of the two-stage pattern).
    d = _det()
    d.detect(np.zeros((240, 320, 3), np.uint8))
    d.detect(np.zeros((240, 320, 3), np.uint8))
    assert d._p.prompt_calls == 1


def test_detect_seg_returns_dets_and_masks():
    dets, masks = _det().detect_seg(np.zeros((100, 120, 3), np.uint8))
    assert dets.shape[1] == 6
    assert isinstance(masks, list) and masks[0].dtype == bool
    assert masks[0].shape == (100, 120)


def test_empty_detection_is_zero6():
    class _Empty(_FakePredictor):
        def infer(self, frame, want_mask):
            return _FakeResult(_FakeResultBoxes(np.zeros((0, 4)), np.zeros((0,)), np.zeros((0,))),
                               _FakeMasks(np.zeros((0, frame.shape[0], frame.shape[1]))) if want_mask else None)
    d = YoloeVpDetector(np.zeros((4, 4, 3), np.uint8), [0, 0, 4, 4], ["x"], _predictor=_Empty())
    assert d.detect(np.zeros((8, 8, 3), np.uint8)).shape == (0, 6)
    dd, mm = d.detect_seg(np.zeros((8, 8, 3), np.uint8))
    assert dd.shape == (0, 6) and mm == []

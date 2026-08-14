# mcp/tracking/py/tests/test_detector_protocol.py
import numpy as np

from libitrack.detector_base import DetectorProtocol
from libitrack.detect import Detector


def test_detector_is_protocol_instance():
    # Passes via MRO (Detector explicitly inherits DetectorProtocol); the real
    # structural regression guard is test_frozen_detector_output_shape_unchanged.
    assert isinstance(Detector.__new__(Detector), DetectorProtocol)


def test_protocol_declares_nx6_contract():
    assert hasattr(DetectorProtocol, "detect")
    assert hasattr(DetectorProtocol, "detect_seg")


def test_frozen_detector_output_shape_unchanged():
    # Regression guard: the frozen ONNX path returns (N,6) [x1,y1,x2,y2,conf,cls]
    # and (N,6),masks for seg — Family A must not alter this. Hermetic: stub the
    # onnxruntime session so no model file is needed.
    import libitrack.detect as d

    class _FakeSess:
        def __init__(self, *a, **k): pass
        def get_inputs(self):
            class _I:
                name = "images"
                shape = [1, 3, 640, 640]
            return [_I()]
        def run(self, *_a, **_k):
            row = np.zeros((1, 37, 8400), np.float32)
            row[0, 0, 0] = 320.0
            row[0, 1, 0] = 320.0
            row[0, 2, 0] = 64.0
            row[0, 3, 0] = 128.0
            row[0, 4, 0] = 0.9
            proto = np.zeros((1, 32, 160, 160), np.float32)
            return [row, proto]

    import onnxruntime as ort
    orig = ort.InferenceSession
    ort.InferenceSession = _FakeSess
    try:
        det = Detector(classes=["person"])
        out = det.detect(np.zeros((640, 640, 3), np.uint8))
        assert out.ndim == 2 and out.shape[1] == 6
        dets, masks = det.detect_seg(np.zeros((640, 640, 3), np.uint8))
        assert dets.shape[1] == 6 and isinstance(masks, list)
    finally:
        ort.InferenceSession = orig


def test_frozen_detector_empty_path_shape():
    # All class scores 0.0 < conf threshold → the empty-return branch.
    # Confirms detect→(0,6) and detect_seg→((0,6), []) — the contract's
    # "none" case, not covered by the N>=1 test above.
    import numpy as np

    class _EmptySess:
        def __init__(self, *a, **k): pass
        def get_inputs(self):
            class _I:
                name = "images"
                shape = [1, 3, 640, 640]
            return [_I()]
        def run(self, *_a, **_k):
            row = np.zeros((1, 37, 8400), np.float32)  # all scores 0.0
            proto = np.zeros((1, 32, 160, 160), np.float32)
            return [row, proto]

    import onnxruntime as ort
    orig = ort.InferenceSession
    ort.InferenceSession = _EmptySess
    try:
        det = Detector(classes=["person"])
        out = det.detect(np.zeros((640, 640, 3), np.uint8))
        assert out.shape == (0, 6)
        dets, masks = det.detect_seg(np.zeros((640, 640, 3), np.uint8))
        assert dets.shape == (0, 6) and masks == []
    finally:
        ort.InferenceSession = orig

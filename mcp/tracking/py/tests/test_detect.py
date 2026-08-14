import numpy as np
from libitrack.detect import Detector


def test_detector_returns_Nx6_on_a_synthetic_frame():
    det = Detector(classes=["person"])
    frame = (np.random.rand(720, 1280, 3) * 255).astype("uint8")
    dets = det.detect(frame)
    assert dets.ndim == 2 and dets.shape[1] == 6  # x1,y1,x2,y2,conf,cls

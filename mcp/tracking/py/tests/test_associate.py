import numpy as np
from libitrack.associate import Associator


def test_stable_id_on_a_linearly_moving_box():
    a = Associator(with_reid=False)  # motion-only: deterministic, network-free
    frame = np.zeros((480, 640, 3), np.uint8)
    ids = []
    for i in range(10):
        x = 100 + i * 5
        dets = np.array([[x, 100, x + 40, 180, 0.9, 0]], np.float32)
        out = a.update(dets, frame)
        if len(out):
            ids.append(int(out[0][4]))
    assert len(set(ids)) == 1  # one stable track id


def test_reset_clears_state():
    a = Associator(with_reid=False)
    frame = np.zeros((480, 640, 3), np.uint8)
    a.update(np.array([[10, 10, 50, 50, 0.9, 0]], np.float32), frame)
    a.reset()
    assert a.frame_count == 0

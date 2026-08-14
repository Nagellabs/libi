"""task-39 Bug 1 — the associator must never gate stricter than the
detectors' emit floor.

BoxMOT's stock BotSort defaults (track_high_thresh=0.5, new_track_thresh=0.6)
meant a detection in [CONF_FLOOR_DEFAULT, 0.5) could never BIRTH a track: it
only participates in the second association stage against tracks that never
exist. On ordinary low-res footage (320x240, person conf ~0.26-0.43) the
detector saw the subject on every frame while the pipeline emitted an
all-invisible track. Reproduced + verified fixed on real 320x240 footage
(63/63 samples visible post-fix at conf ~0.43; 63 samples / 0 visible before).
"""
import numpy as np

from libitrack.associate import Associator
from libitrack.detector_base import CONF_FLOOR_DEFAULT


def test_track_birth_gates_equal_detector_conf_floor():
    a = Associator(with_reid=False)  # motion-only: deterministic, network-free
    assert a.tracker.track_high_thresh == CONF_FLOOR_DEFAULT
    assert a.tracker.new_track_thresh == CONF_FLOOR_DEFAULT
    # The low-conf second-stage band stays at boxmot's default.
    assert a.tracker.track_low_thresh <= CONF_FLOOR_DEFAULT


def test_low_res_confidence_band_births_a_track():
    """A steady detection at conf 0.34 (the real 320x240 person confidence)
    must produce a track — with the stock thresholds it produced none."""
    a = Associator(with_reid=False)
    frame = np.zeros((240, 320, 3), np.uint8)
    ids = []
    for i in range(10):
        x = 149 + i  # slight motion, like the real footage
        dets = np.array([[x, 108, x + 25, 135, 0.34, 0]], np.float32)
        out = a.update(dets, frame)
        if len(out):
            ids.append(int(out[0][4]))
    assert len(ids) > 0, "a conf-0.34 detection never birthed a track"
    assert len(set(ids)) == 1  # and the id is stable


def test_reset_preserves_the_aligned_gates():
    a = Associator(with_reid=False)
    a.reset()
    assert a.tracker.track_high_thresh == CONF_FLOOR_DEFAULT
    assert a.tracker.new_track_thresh == CONF_FLOOR_DEFAULT

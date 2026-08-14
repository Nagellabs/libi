import numpy as np

from libitrack.matte import pick_seed_instance


def _mask(h, w, y0, y1, x0, x1):
    m = np.zeros((h, w), bool)
    m[y0:y1, x0:x1] = True
    return m


def _dets(*boxes):
    # rows: [x1, y1, x2, y2, conf, cls]
    return np.array([[*b, 0.9, 0.0] for b in boxes], np.float32)


def test_auto_picks_largest_instance():
    dets = _dets([0, 0, 10, 10], [20, 20, 80, 90])
    masks = [_mask(100, 100, 0, 10, 0, 10), _mask(100, 100, 20, 90, 20, 80)]
    assert pick_seed_instance(dets, masks, None) is masks[1]


def test_seed_box_picks_best_iou_instance():
    dets = _dets([0, 0, 10, 10], [20, 20, 80, 90])
    masks = [_mask(100, 100, 0, 10, 0, 10), _mask(100, 100, 20, 90, 20, 80)]
    # seed box [x, y, w, h] overlapping only the small first instance
    assert pick_seed_instance(dets, masks, [1, 1, 8, 8]) is masks[0]


def test_no_detections_returns_none():
    assert pick_seed_instance(np.zeros((0, 6), np.float32), [], None) is None


def test_seed_box_overlapping_nothing_returns_none():
    dets = _dets([0, 0, 10, 10])
    masks = [_mask(100, 100, 0, 10, 0, 10)]
    assert pick_seed_instance(dets, masks, [80, 80, 10, 10]) is None

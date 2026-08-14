from libitrack.bind import pick_track_for_anchor


def test_picks_highest_iou_track_at_anchor_time():
    tracks = [(7, [100, 100, 200, 200]), (9, [400, 400, 450, 450])]
    anchor_xywh = [110, 110, 90, 90]
    tid = pick_track_for_anchor(tracks, anchor_xywh, reid_sims=None)
    assert tid == 7


def test_reid_breaks_low_iou_ties():
    tracks = [(1, [0, 0, 10, 10]), (2, [0, 0, 10, 10])]
    anchor_xywh = [500, 500, 10, 10]  # no IoU overlap with either
    tid = pick_track_for_anchor(tracks, anchor_xywh, reid_sims={1: 0.2, 2: 0.9})
    assert tid == 2

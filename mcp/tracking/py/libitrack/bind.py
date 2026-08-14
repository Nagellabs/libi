"""Anchor↔track binding: IoU primary key, ReID similarity tiebreak.

No ML deps — pure stdlib Python.
"""


def _iou(a: list, b: list) -> float:
    """Compute IoU between two [x1, y1, x2, y2] boxes."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


# Minimum IoU to accept an anchor↔track match outright. Single source of
# truth: pipeline.py's anchor re-validation imports this so the
# re-validation floor and the initial-binding floor can never drift apart.
IOU_FLOOR_DEFAULT = 0.1


def pick_track_for_anchor(
    tracks: list,
    anchor_xywh: list,
    reid_sims: dict | None = None,
    iou_floor: float = IOU_FLOOR_DEFAULT,
) -> int | None:
    """Select the best-matching track id for an anchor box.

    Args:
        tracks:      [(track_id, [x1, y1, x2, y2]), ...] candidates at the
                     anchor's timestamp.
        anchor_xywh: anchor bounding box as [x, y, w, h].
        reid_sims:   optional dict {track_id: similarity_score} for ReID
                     tiebreaking when IoU is below iou_floor.
        iou_floor:   minimum IoU to accept an IoU winner outright.  When
                     best IoU < iou_floor the function falls back to ReID.

    Returns:
        The winning track id, or None if tracks is empty.
    """
    ax, ay, aw, ah = anchor_xywh
    abox = [ax, ay, ax + aw, ay + ah]

    best_id, best_iou = None, -1.0
    for tid, box in tracks:
        v = _iou(abox, box)
        if v > best_iou:
            best_iou, best_id = v, tid

    if best_iou >= iou_floor:
        return best_id

    # IoU below floor — fall back to ReID similarity
    if reid_sims:
        return max(reid_sims.items(), key=lambda kv: kv[1])[0]

    return best_id

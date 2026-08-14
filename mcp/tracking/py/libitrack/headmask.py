"""Derive a stable HEAD box from a person *silhouette mask*.

Why this exists: deriving the head from a person *bounding box* (top-centre
of the box) breaks the moment a limb goes above/beside the head — a raised
hand or a dance move grows the box toward the limb, so the "head" drifts
onto the arm and balloons. A face *detector* (YuNet / MediaPipe) fails on
back-to-camera / profile / fast concert footage (no frontal face).

A segmentation *mask* gives shape, not just extent. A raised arm is a thin
protrusion of the silhouette; the head is a roughly head-sized blob at the
top of the torso. Working from the mask we can find that blob and ignore
the arm — no frontal face required, no balloon when the box reshapes.

`head_box_from_mask(mask, person_box)` → ``[x, y, w, h]`` (ints) or
``None`` when the mask is too small / no plausible head.
"""
from __future__ import annotations

import cv2
import numpy as np


def head_box_from_mask(mask: np.ndarray, person_box) -> list[int] | None:
    """Estimate the head bounding box from a person instance mask.

    Args:
        mask: full-frame ``bool`` (or 0/1) array — the person silhouette.
        person_box: ``[x1, y1, x2, y2]`` of the person (pixel coords).

    Returns:
        ``[x, y, w, h]`` head box (pixel ints) or ``None``.
    """
    if mask is None:
        return None
    m = mask.astype(np.uint8)
    H, W = m.shape[:2]
    x1, y1, x2, y2 = (int(round(v)) for v in person_box)
    x1 = max(0, min(x1, W - 1))
    x2 = max(x1 + 1, min(x2, W))
    y1 = max(0, min(y1, H - 1))
    y2 = max(y1 + 1, min(y2, H))
    box_w = x2 - x1
    box_h = y2 - y1
    if box_w < 6 or box_h < 6:
        return None

    sub = m[y1:y2, x1:x2]
    if int(sub.sum()) < 20:
        return None

    # Per-row silhouette width (pixel count) from the top of the box down.
    row_w = sub.sum(axis=1).astype(np.int32)

    # Expected head width ≈ a fraction of the body-box width. A straight
    # raised arm is far narrower than this, so requiring a row to reach
    # `min_head_w` before we call it "head" skips a thin arm column that
    # protrudes above the actual head.
    exp_head_w = max(6.0, box_w * 0.42)
    min_head_w = exp_head_w * 0.5

    rows = np.where(row_w >= min_head_w)[0]
    if rows.size == 0:
        # Silhouette never reaches head width (very small / odd mask) —
        # fall back to the topmost mask rows.
        rows = np.where(row_w > 0)[0]
        if rows.size == 0:
            return None
    head_top = int(rows[0])

    # Head ends where the silhouette widens into the shoulders. Reference
    # width = median of the first few head rows; shoulders ≈ 1.7× that.
    ref_band = row_w[head_top : head_top + max(3, box_h // 20)]
    ref = float(np.median(ref_band[ref_band > 0])) if np.any(ref_band > 0) else exp_head_w
    shoulder_thresh = max(ref * 1.7, exp_head_w * 1.3)
    head_bottom = box_h
    for ry in range(head_top + 1, box_h):
        if row_w[ry] >= shoulder_thresh:
            head_bottom = ry
            break

    # Sane clamps: head height bounded relative to body height and to a
    # roughly-square head, so a bad mask can't produce a tall slab.
    head_h = head_bottom - head_top
    head_h = int(min(head_h, box_h * 0.38))
    head_h = int(max(head_h, min(box_h, exp_head_w * 0.8)))
    head_top_a = y1 + head_top
    head_bot_a = min(y2, head_top_a + head_h)

    band = m[head_top_a:head_bot_a, x1:x2]
    if int(band.sum()) < 10:
        return None

    # Within the head band, take the LARGEST connected component — the
    # head+neck blob. A raised arm at head height is a separate, smaller
    # component and is correctly ignored; its width also won't dominate.
    n, _lbl, stats, _cent = cv2.connectedComponentsWithStats(
        band.astype(np.uint8), connectivity=8
    )
    if n <= 1:
        return None
    # stats[0] is background; pick the largest foreground component.
    areas = stats[1:, cv2.CC_STAT_AREA]
    bi = int(np.argmax(areas)) + 1
    bx = int(stats[bi, cv2.CC_STAT_LEFT])
    bw = int(stats[bi, cv2.CC_STAT_WIDTH])
    bh = int(stats[bi, cv2.CC_STAT_HEIGHT])
    by = int(stats[bi, cv2.CC_STAT_TOP])

    hx = x1 + bx
    hy = head_top_a + by
    hw = bw
    hh = bh
    # Keep it from being absurdly wide/tall vs an expected head: clamp
    # width to ≤ ~1.5× expected head width, recentre on the component.
    cx = hx + hw / 2.0
    cy = hy + hh / 2.0
    hw = int(min(hw, exp_head_w * 1.6))
    hh = int(min(hh, exp_head_w * 1.9))
    hw = max(hw, 6)
    hh = max(hh, 6)
    hx = int(round(cx - hw / 2.0))
    hy = int(round(cy - hh / 2.0))
    hx = max(0, min(hx, W - 1))
    hy = max(0, min(hy, H - 1))
    hw = min(hw, W - hx)
    hh = min(hh, H - hy)
    if hw < 4 or hh < 4:
        return None
    return [hx, hy, hw, hh]

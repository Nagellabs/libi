"""head_box_from_mask: derive the HEAD from a person silhouette, robust
to a raised arm.

Synthetic silhouette (200×200): a torso rectangle, a round head on top,
a neck joining them, and a THIN arm column raised straight up so it
extends ABOVE the head — i.e. the person *bounding box* top is the
fingertip, the classic case where bbox-top head derivation drifts onto
the arm. The mask-based head must instead land on the head blob.
"""
import numpy as np

from libitrack.headmask import head_box_from_mask


def _silhouette():
    m = np.zeros((200, 200), np.uint8)
    # torso/legs rectangle
    m[90:190, 70:130] = 1
    # head disc centred at (100, 70), r=18  → y∈[52,88], x∈[82,118]
    yy, xx = np.ogrid[:200, :200]
    m[((yy - 70) ** 2 + (xx - 100) ** 2) <= 18 * 18] = 1
    # neck
    m[80:95, 92:108] = 1
    # raised arm: thin column x∈[120,128], from y=20 (well above the head
    # top at y=52) down to the shoulder
    m[20:95, 120:128] = 1
    # person bounding box: note y starts at 20 — the ARM, not the head
    box = [70, 20, 130, 190]
    return m.astype(bool), box


def test_head_box_lands_on_head_not_the_raised_arm():
    mask, box = _silhouette()
    hb = head_box_from_mask(mask, box)
    assert hb is not None, "expected a head box"
    x, y, w, h = hb
    cx, cy = x + w / 2, y + h / 2

    # Centred on the head disc (~x=100), NOT pulled toward the arm (~x=124).
    assert 86 <= cx <= 114, f"head centre x={cx} drifted off the head"
    # Vertically on the head (disc ~y52–88), NOT at the arm top (y=20).
    assert 45 <= cy <= 100, f"head centre y={cy} not on the head"
    assert y >= 40, f"head box top y={y} reaches up the raised arm"

    # Head-SIZED: nowhere near the full body box (60×170). A head disc is
    # ~36px; allow slack for neck inclusion but it must stay small.
    assert w <= 70 and h <= 80, f"head box {w}x{h} is body-sized"
    assert w >= 12 and h >= 12, f"head box {w}x{h} collapsed"
    # And it must not stretch down through the torso.
    assert (y + h) <= 130, f"head box bottom {y + h} runs into the torso"


def test_returns_none_on_empty_or_tiny_mask():
    assert head_box_from_mask(np.zeros((50, 50), bool), [0, 0, 50, 50]) is None
    assert head_box_from_mask(None, [0, 0, 10, 10]) is None

"""task-39 follow-up — the degenerate-box veto killed anchor picks for any
subject taller than 0.82*H, producing `no_output` on perfectly good footage.

`_is_degenerate_box` grew an `anchor_bound` escape hatch for "the portrait
zero-output bug", but it relaxed ONLY the frame-edge arm. The ABSOLUTE size
arms (w >= 0.82W, h >= 0.82H, area >= 0.55WH) kept firing on anchor picks —
so a normal close-up still got vetoed on every frame and the track came back
with zero visible samples.

Measured 2026-08-02 on real 1280x720 NASA footage during the dev-build E2E:
an astronaut grounded at 0.945 detector confidence produced a 639x656 anchor.
656 >= 0.82*720 (590.4) fired the height arm, and the default
`yoloe+botsort` method returned `no_output` (0/300 visible) on footage that
`method:"sot"` tracked at 295/300 = 98.3%. Close-ups are not an edge case:
talking heads, interviews, UGC selfies and product macros routinely exceed
82% of frame height.

The fix compares an anchor-bound candidate against the ANCHOR instead of
against the frame — "has it ballooned away from what was pointed at?" — which
keeps the anti-ballooning protection the absolute arms existed for. Both
anchor-bound call sites only fire within +/-2 frames of the anchor, so the two
boxes are effectively simultaneous and their sizes should match closely.
"""

from libitrack.pipeline import ANCHOR_BALLOON_AREA_RATIO, _is_degenerate_box


def xywh_to_xyxy(b):
    x, y, w, h = b
    return [x, y, x + w, y + h]


# The real anchor from the failing run.
ASTRONAUT_ANCHOR_XYWH = [303.7958, 61.2242, 639.4404, 656.0145]
FRAME_W, FRAME_H = 1280, 720


def test_the_regression_the_absolute_height_arm_would_still_fire():
    """Guards the premise: this box IS over the absolute height threshold.
    If this ever stops being true the test below proves nothing."""
    box = xywh_to_xyxy(ASTRONAUT_ANCHOR_XYWH)
    h = box[3] - box[1]
    assert h >= 0.82 * FRAME_H
    # …and with no anchor box supplied it is still refused, unchanged.
    assert _is_degenerate_box(box, FRAME_W, FRAME_H, anchor_bound=True) is True


def test_anchor_pick_matching_its_own_anchor_is_not_degenerate():
    """The bug: a candidate that IS the anchored subject was vetoed."""
    box = xywh_to_xyxy(ASTRONAUT_ANCHOR_XYWH)
    assert (
        _is_degenerate_box(
            box,
            FRAME_W,
            FRAME_H,
            anchor_bound=True,
            anchor_xywh=ASTRONAUT_ANCHOR_XYWH,
        )
        is False
    )


def test_small_wobble_around_the_anchor_still_accepted():
    x, y, w, h = ASTRONAUT_ANCHOR_XYWH
    for scale in (0.85, 1.0, 1.15):
        box = xywh_to_xyxy([x, y, w * scale, h * scale])
        assert (
            _is_degenerate_box(
                box, FRAME_W, FRAME_H, anchor_bound=True, anchor_xywh=ASTRONAUT_ANCHOR_XYWH
            )
            is False
        ), f"scale {scale} should track as the same subject"


def test_a_true_balloon_is_still_refused():
    """Anti-ballooning must survive the relaxation — a full-frame box is
    still >1.6x this anchor's area even though the anchor already fills
    ~45% of the frame."""
    full_frame = [0.0, 0.0, float(FRAME_W), float(FRAME_H)]
    assert (
        _is_degenerate_box(
            full_frame,
            FRAME_W,
            FRAME_H,
            anchor_bound=True,
            anchor_xywh=ASTRONAUT_ANCHOR_XYWH,
        )
        is True
    )


def test_balloon_from_a_small_anchor_is_refused():
    small_anchor = [100.0, 100.0, 80.0, 200.0]  # a distant person
    ballooned = xywh_to_xyxy([100.0, 100.0, 300.0, 600.0])
    assert (
        _is_degenerate_box(
            ballooned, FRAME_W, FRAME_H, anchor_bound=True, anchor_xywh=small_anchor
        )
        is True
    )


def test_ratio_boundary_is_the_declared_constant():
    """area exactly at the ratio is accepted; just over it is refused."""
    anchor = [0.0, 0.0, 100.0, 100.0]  # area 10_000
    at = (10_000 * ANCHOR_BALLOON_AREA_RATIO) ** 0.5
    just_over = at * 1.01
    assert (
        _is_degenerate_box(
            [0.0, 0.0, at, at], FRAME_W, FRAME_H, anchor_bound=True, anchor_xywh=anchor
        )
        is False
    )
    assert (
        _is_degenerate_box(
            [0.0, 0.0, just_over, just_over],
            FRAME_W,
            FRAME_H,
            anchor_bound=True,
            anchor_xywh=anchor,
        )
        is True
    )


def test_blind_rebinds_keep_the_absolute_arms_unchanged():
    """No anchor box => the cameraman/edge protections must be untouched."""
    # Edge-pinned, tall and narrow: the classic background-cameraman box.
    edge_box = [0.0, 0.0, 10.0, 400.0]
    assert _is_degenerate_box(edge_box, FRAME_W, FRAME_H, anchor_bound=False) is True
    # Oversized with no anchor context.
    assert (
        _is_degenerate_box(
            [0.0, 0.0, float(FRAME_W), float(FRAME_H)], FRAME_W, FRAME_H
        )
        is True
    )


def test_non_positive_boxes_are_always_degenerate():
    for box in ([10.0, 10.0, 10.0, 50.0], [10.0, 10.0, 50.0, 10.0]):
        assert (
            _is_degenerate_box(
                box, FRAME_W, FRAME_H, anchor_bound=True, anchor_xywh=ASTRONAUT_ANCHOR_XYWH
            )
            is True
        )

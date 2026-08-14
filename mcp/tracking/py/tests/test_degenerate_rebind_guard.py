from libitrack.pipeline import _is_degenerate_box

W, H = 608, 1080


def test_normal_centered_person_is_not_degenerate():
    # ~200x500 person box near center — a real subject.
    assert _is_degenerate_box([200.0, 300.0, 400.0, 800.0], W, H) is False


def test_oversized_box_is_degenerate():
    # ~89% height — the bad full-frame detection.
    assert _is_degenerate_box([206.0, 60.0, 564.0, 1020.0], W, H) is True


def test_edge_pinned_tall_narrow_is_degenerate():
    # hugging the left edge, tall & narrow — the cameraman signature.
    assert _is_degenerate_box([0.0, 100.0, 28.0, 520.0], W, H) is True


def test_zero_or_negative_box_is_degenerate():
    assert _is_degenerate_box([10.0, 10.0, 10.0, 10.0], W, H) is True
    assert _is_degenerate_box([50.0, 50.0, 40.0, 40.0], W, H) is True


def test_area_threshold_alone_is_degenerate():
    # Box: x1=40,y1=100,x2=480,y2=950 with W=608,H=1080.
    # w=440 < 0.82*608=498.56 → per-dim width check False
    # h=850 < 0.82*1080=885.6  → per-dim height check False
    # area=440*850=374000 >= 0.55*608*1080=361152 → area check True (degenerate)
    # x1=40>0.02*608=12.16, x2=480<0.98*608=595.84 → edge-pin check False
    # Only the w*h branch fires.
    assert _is_degenerate_box([40.0, 100.0, 480.0, 950.0], W, H) is True


# The REAL production failure: a 9:16 portrait frame (608x1080). The subject
# (IShowSpeed) is picked by the anchor at IoU ~0.9 but the box touches the
# right edge and is tall/narrow, so the edge-pinned arm vetoed it EVERY frame
# and the segment bound nothing. An ANCHOR-picked candidate is identity ground
# truth and must never be refused by the edge arm.
REAL_ANCHOR_BOX = [361.9, 318.3, 606.9, 945.4]  # x2=606.9 >= 0.98*608=595.8; h=627 > 1.4*w=343


def test_anchor_bound_edge_box_is_not_degenerate():
    # As a BLIND re-bind (default) the edge arm still fires — unchanged.
    assert _is_degenerate_box(REAL_ANCHOR_BOX, W, H) is True
    # As an ANCHOR-picked bind the edge arm is disabled → accepted.
    assert _is_degenerate_box(REAL_ANCHOR_BOX, W, H, anchor_bound=True) is False


def test_anchor_bound_does_not_excuse_oversized_or_nonpositive():
    # anchor_bound relaxes ONLY the edge arm — a genuinely full-frame or
    # zero-area box is still degenerate even when anchor-picked.
    assert _is_degenerate_box([206.0, 60.0, 564.0, 1020.0], W, H, anchor_bound=True) is True  # ~89% height
    assert _is_degenerate_box([10.0, 10.0, 10.0, 10.0], W, H, anchor_bound=True) is True       # zero-area


def test_default_signature_unchanged_for_blind_rebind():
    # A background cameraman hugging the left edge is still refused by default.
    assert _is_degenerate_box([0.0, 100.0, 28.0, 520.0], W, H) is True

"""A subject present in shot A and shot B must keep ONE identity across the
cut even when only shot A has an anchor (the 127/1152 bug)."""
from libitrack.pipeline import _carry_bound_box


def test_carry_bound_box_reacquires_same_subject_after_cut():
    # Last bound box at end of shot A (xyxy).
    last = [100.0, 100.0, 180.0, 260.0]
    # New shot's tracks: id 7 is the same person (overlaps last), id 9 is a
    # cameraman at the frame edge.
    tracks = [(7, [104.0, 98.0, 184.0, 262.0]), (9, [0.0, 0.0, 30.0, 400.0])]
    assert _carry_bound_box(tracks, last) == 7

    # No plausible continuation (everything disjoint) -> None (honest miss,
    # NOT a silent latch onto the edge person).
    far = [(9, [0.0, 0.0, 30.0, 400.0])]
    assert _carry_bound_box(far, last) is None

    # Degenerate inputs: guard clause must return None without raising.
    assert _carry_bound_box([], last) is None          # empty tracks
    assert _carry_bound_box(tracks, None) is None      # no carried box

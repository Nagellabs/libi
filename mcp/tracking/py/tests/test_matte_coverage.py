"""Unit: alpha-coverage classification (`libitrack.matte.classify_coverage`).

Why this exists: `matte_gen` previously reported only `frameCount` — a COUNT,
which CLAUDE.md explicitly calls "necessary but NOT sufficient". This feature's
own spike proved the hole empirically: a run produced 181 alpha PNGs and passed
every count-based check while EVERY PIXEL was zero (a mask-convention bug). The
matte looked green and rendered nothing.

Tracking has `summarizeTrack` flags + an `add_tracked_overlay` refusal for this
class of silent failure; matting had no analogue. `classify_coverage` is that
analogue: it turns "how much of the frame did the matte actually keep" into an
honest, blocking signal. Pure and torch-free so it is testable without the
inference stack.
"""

from libitrack.matte import (
    EMPTY_COVERAGE_MAX,
    FULL_FRAME_COVERAGE_MIN,
    classify_coverage,
)


def test_all_zero_alpha_is_flagged_empty():
    # The exact spike failure: every pixel transparent -> the cutout renders
    # nothing, but frameCount is healthy.
    assert classify_coverage(0.0) == ["empty_matte"]


def test_near_zero_alpha_is_flagged_empty():
    assert classify_coverage(EMPTY_COVERAGE_MAX / 2) == ["empty_matte"]


def test_full_frame_alpha_is_flagged():
    # Matte kept the whole frame -> nothing was removed; compositing it over a
    # new background shows the ORIGINAL scene, the silent no-op.
    assert classify_coverage(1.0) == ["full_frame_matte"]
    assert classify_coverage((FULL_FRAME_COVERAGE_MIN + 1.0) / 2) == [
        "full_frame_matte"
    ]


def test_realistic_subject_coverage_is_clean():
    # Measured on real footage: a talking-head subject occupies roughly
    # 4%-30% of frame. None of that may flag.
    for c in (0.045, 0.10, 0.15, 0.30, 0.60):
        assert classify_coverage(c) == [], f"{c} should be clean"


def test_boundaries_are_inclusive_on_the_clean_side():
    # Exactly at the thresholds is NOT a failure — only beyond them.
    assert classify_coverage(EMPTY_COVERAGE_MAX) == []
    assert classify_coverage(FULL_FRAME_COVERAGE_MIN) == []

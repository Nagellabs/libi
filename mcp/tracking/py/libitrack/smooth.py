"""Temporal smoothing for track samples.

Two-pass algorithm:
1. EMA over visible samples only — smooths jitter in detected positions.
2. Coast short invisible gaps by linear interpolation — fills blinks and
   brief occlusions up to max_coast_frames.  Gaps longer than that stay
   honestly invisible so callers know the subject was truly lost.
"""


def smooth_samples(
    samples: list[dict],
    alpha: float = 0.4,
    max_coast_frames: int = 3,
) -> list[dict]:
    """Return a new list of sample dicts with smoothing applied.

    Args:
        samples: list of dicts with keys t, x, y, w, h, confidence, visible.
        alpha: EMA weight for the current visible frame (0 < alpha <= 1).
               Closer to 1 = less smoothing (trust current more).
        max_coast_frames: maximum consecutive invisible frames to fill by
                          linear interpolation between neighbours.

    Returns:
        New list of dicts (originals are not mutated).
    """
    out = [dict(s) for s in samples]

    # Pass 1 — EMA over visible runs.
    # Each visible frame is blended toward the previous visible frame's
    # smoothed position.  Invisible frames reset the EMA anchor so a
    # reappearance after a long gap starts fresh.
    prev = None
    for o in out:
        if o["visible"]:
            if prev is not None:
                for k in ("x", "y", "w", "h"):
                    o[k] = alpha * o[k] + (1 - alpha) * prev[k]
            prev = {k: o[k] for k in ("x", "y", "w", "h")}
        else:
            prev = None

    # Pass 2 — coast short invisible gaps by linear interpolation.
    # Walk the sequence; when we hit an invisible run check its length.
    # If it is short enough AND it has a visible neighbour on both sides,
    # fill each frame with an interpolated position and mark it visible.
    i = 0
    n = len(out)
    while i < n:
        if not out[i]["visible"]:
            j = i
            while j < n and not out[j]["visible"]:
                j += 1
            gap = j - i
            if 0 < i and j < n and gap <= max_coast_frames:
                a, b = out[i - 1], out[j]
                for g in range(gap):
                    u = (g + 1) / (gap + 1)
                    for k in ("x", "y", "w", "h"):
                        out[i + g][k] = a[k] + (b[k] - a[k]) * u
                    out[i + g]["visible"] = True
                    out[i + g]["confidence"] = (
                        min(a["confidence"], b["confidence"]) * 0.5
                    )
            i = j
        else:
            i += 1

    # Pass 3 — robust size clamp. Detector/bind size spikes (a box that
    # briefly balloons then snaps back) make a fitted overlay flash. Clamp
    # each visible frame's w,h into the rolling median +/- SIZE_CLAMP, keeping
    # the box CENTER fixed so position/tracking is untouched.
    SIZE_WIN = 15
    SIZE_CLAMP = 1.6
    vis_idx = [
        k for k, o in enumerate(out) if o["visible"] and o["w"] > 0 and o["h"] > 0
    ]
    pos = {k: p for p, k in enumerate(vis_idx)}
    for k in vis_idx:
        p = pos[k]
        lo = max(0, p - SIZE_WIN)
        hi = min(len(vis_idx), p + SIZE_WIN + 1)
        win = vis_idx[lo:hi]
        ws = sorted(out[j]["w"] for j in win)
        hs = sorted(out[j]["h"] for j in win)
        mw = ws[len(ws) // 2]
        mh = hs[len(hs) // 2]
        o = out[k]
        cx = o["x"] + o["w"] / 2.0
        cy = o["y"] + o["h"] / 2.0
        nw = min(mw * SIZE_CLAMP, max(mw / SIZE_CLAMP, o["w"]))
        nh = min(mh * SIZE_CLAMP, max(mh / SIZE_CLAMP, o["h"]))
        o["w"], o["h"] = nw, nh
        o["x"], o["y"] = cx - nw / 2.0, cy - nh / 2.0

    return out

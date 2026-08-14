from libitrack.smooth import smooth_samples


def s(t, x, vis=True):
    return {"t": t, "x": x, "y": 0, "w": 10, "h": 10,
            "confidence": 1.0 if vis else 0.0, "visible": vis}


def test_short_gap_is_coasted():
    seq = [s(0, 0), s(1, 10), {"t": 2, "x": 0, "y": 0, "w": 0, "h": 0,
            "confidence": 0, "visible": False}, s(3, 30)]
    out = smooth_samples(seq, max_coast_frames=2)
    assert out[2]["visible"] is True


def test_long_gap_stays_invisible():
    seq = [s(0, 0)] + [{"t": i, "x": 0, "y": 0, "w": 0, "h": 0,
            "confidence": 0, "visible": False} for i in range(1, 6)] + [s(6, 60)]
    out = smooth_samples(seq, max_coast_frames=2)
    assert all(o["visible"] is False for o in out[1:6])

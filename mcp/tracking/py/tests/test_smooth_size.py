from libitrack.smooth import smooth_samples


def mk(n, w=80, h=60):
    return [
        {
            "t": i / 30,
            "x": 100,
            "y": 100,
            "w": w,
            "h": h,
            "confidence": 1.0,
            "visible": True,
        }
        for i in range(n)
    ]


def test_size_spike_is_clamped_center_preserved():
    # Steady track box is x100,y100,w80,h60 -> center (140,130). Make the
    # spike CONCENTRIC with the track (same center, just huge) so the EMA
    # pass is center-neutral and this isolates Pass-3's invariant: clamp
    # size, preserve the box center.
    s = mk(40)
    s[20] = {
        "t": 20 / 30,
        "x": 140 - 400 / 2,  # center x = 140
        "y": 130 - 300 / 2,  # center y = 130
        "w": 400,
        "h": 300,
        "confidence": 1.0,
        "visible": True,
    }
    out = smooth_samples(s)
    f = out[20]
    assert f["w"] <= 80 * 1.6 + 1.0  # size clamped (no more flash)
    assert f["h"] <= 60 * 1.6 + 1.0
    assert abs((f["x"] + f["w"] / 2) - 140) < 1.0  # center preserved
    assert abs((f["y"] + f["h"] / 2) - 130) < 1.0


def test_steady_track_unchanged_by_size_pass():
    out = smooth_samples(mk(40))
    assert all(abs(o["w"] - 80) < 1e-6 and abs(o["h"] - 60) < 1e-6 for o in out)

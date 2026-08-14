from track_runner import _versions


def test_matanyone_in_selftest_versions():
    v = _versions()
    assert "matanyone" in v
    assert not str(v["matanyone"]).startswith("ERR:")

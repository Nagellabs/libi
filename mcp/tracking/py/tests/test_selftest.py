import json, subprocess, sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[1]

def test_selftest_reports_ok():
    out = subprocess.run(
        [sys.executable, str(ROOT / "track_runner.py"), "--selftest"],
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr
    payload = json.loads(out.stdout.strip().splitlines()[-1])
    assert payload["ok"] is True
    assert "onnxruntime" in payload["versions"]


def test_boxmot_version_is_distribution_not_dunder():
    # boxmot 19.0.0 ships a stale __version__ == "18.0.0"; _versions() must
    # report the installed DISTRIBUTION version so verify_install is honest.
    import importlib.metadata as md
    from track_runner import _versions

    v = _versions()
    assert v["boxmot"] == md.version("boxmot")
    assert not str(v["boxmot"]).startswith("ERR:")

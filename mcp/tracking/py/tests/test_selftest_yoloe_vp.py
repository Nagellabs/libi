# mcp/tracking/py/tests/test_selftest_yoloe_vp.py
import json
import subprocess
import sys
import pathlib

PROJ = pathlib.Path(__file__).resolve().parents[1]  # mcp/tracking/py


def test_selftest_reports_ultralytics_and_yoloe_vp_keys():
    out = subprocess.run(
        [sys.executable, str(PROJ / "track_runner.py"), "--selftest"],
        capture_output=True, text=True, cwd=str(PROJ),
    )
    line = [l for l in out.stdout.splitlines() if l.strip()][-1]
    obj = json.loads(line)
    assert obj["type"] == "selftest"
    assert "ok" in obj and isinstance(obj["ok"], bool)
    assert "ultralytics" in obj["versions"]
    assert "yoloe_vp" in obj["versions"]
    # The synced sidecar venv has ultralytics (Task 5 added it as a runtime
    # dep); the selftest must report real success, not just structural shape.
    assert obj["ok"] is True, f"selftest ok=False; versions={obj['versions']}"
    assert obj["versions"]["yoloe_vp"] == "import-ok"
    assert not str(obj["versions"]["ultralytics"]).startswith("ERR:")

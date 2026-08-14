import libitrack.matte as matte
from libitrack.pipeline import run_segment


def test_matte_method_dispatches_to_run_matte(monkeypatch, capfd):
    calls = {}

    def fake(job, emit):
        calls["job"] = job
        emit(
            {
                "type": "result",
                "samples": [],
                "framerate": 25.0,
                "outputDir": job["outputDir"],
                "frameCount": 0,
                "device": "cpu",
                "msPerFrame": 0.0,
            }
        )
        return 0

    monkeypatch.setattr(matte, "run_matte", fake)
    rc = run_segment(
        {
            "method": "matte",
            "videoPath": "/nonexistent.mp4",
            "range": {"start": 0, "end": 1},
            "outputDir": "/tmp/matte-test",
        }
    )
    assert rc == 0
    assert calls["job"]["outputDir"] == "/tmp/matte-test"
    out = capfd.readouterr().out
    assert '"type": "result"' in out or '"type":"result"' in out

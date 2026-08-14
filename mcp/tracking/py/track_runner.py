"""libi tracking sidecar. Reads a segment job as JSON on stdin (or --selftest),
emits JSON lines: {"type":"progress",...} during work and a final
{"type":"result",...}. Never prints anything else to stdout."""
import sys, json, importlib

def _versions():
    import importlib.metadata as _md

    v = {}
    for m in ("onnxruntime", "cv2", "numpy", "scipy", "boxmot", "ultralytics", "matanyone"):
        try:
            mod = importlib.import_module(m)
            # Prefer the installed DISTRIBUTION version — some packages (boxmot
            # 19 ships a stale __version__ == "18.0.0") lie in their dunder.
            # cv2's distribution name differs from its import name, so fall back
            # to __version__ when metadata lookup misses.
            dist_name = "opencv-python-headless" if m == "cv2" else m
            try:
                v[m] = _md.version(dist_name)
            except Exception:
                v[m] = getattr(mod, "__version__", "?")
        except Exception as e:  # pragma: no cover
            v[m] = f"ERR:{e}"
    # YOLOE-VP predictor import smoke (Family A eager backend). Use the SAME
    # class detect_yoloe_vp._RealPredictor uses — YOLOEVPSegPredictor (the
    # spike proved YOLOEVPDetectPredictor crashes on the seg model).
    try:
        from ultralytics.models.yolo.yoloe.predict import (  # noqa: F401
            YOLOEVPSegPredictor,
        )

        v["yoloe_vp"] = "import-ok"
    except Exception as e:  # pragma: no cover
        v["yoloe_vp"] = f"ERR:{e}"
    return v


def selftest() -> int:
    versions = _versions()
    ok = not any(str(val).startswith("ERR:") for val in versions.values())
    print(json.dumps({"type": "selftest", "ok": ok, "versions": versions}))
    return 0

def main(argv) -> int:
    if "--selftest" in argv:
        return selftest()
    job = json.loads(sys.stdin.read())
    from libitrack.pipeline import run_segment  # imported lazily (added in a later task)
    return run_segment(job)

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

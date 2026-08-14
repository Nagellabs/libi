"""Build-at-install YOLOE ONNX export (driven by the tracking-pyenv installer).

Re-parameterizes the sha-pinned ``yoloe-11s-seg.pt`` checkpoint (models.json
``yoloe_vp``) with the frozen text vocabulary and exports the ONNX that the
frozen ``Detector`` (libitrack/detect.py) runs at inference time.

Why build locally instead of hosting: every input is AGPL-3.0 (ultralytics,
the YOLOE weights, the ultralytics/CLIP fork), so exporting on the user's own
machine avoids libi redistributing an AGPL-derived binary. The output sha256
is host-specific (the export embeds non-deterministic metadata) — integrity is
anchored on the sha-pinned INPUTS plus the onnxruntime shape validation below;
the installer records the produced sha in ``yoloe11.onnx.build-info.json``.

Invocation (see ``mcp/registry/installers/tracking-pyenv.ts#ensureBuiltModel``):

    uv run --locked --with "<clipRequirement>" python export_yoloe11.py \
        --pt <models>/yoloe-11s-seg.pt \
        --encoder <models>/.build/mobileclip_blt.ts \
        --out <models>/yoloe11.onnx \
        --classes person --imgsz 640 --opset 17

The pinned CLIP commit archive is an EXPORT-TIME-ONLY dep (tokenizer for
``get_text_pe``) supplied via ``uv run --with`` so the locked sidecar venv is
never mutated. The 572MB ``mobileclip_blt.ts`` text encoder is pre-fetched and
sha-verified by the installer; this script chdirs next to it so ultralytics
finds the file by its relative name and never re-downloads it.

stdout protocol: ultralytics prints progress lines; the FINAL line this script
emits is one JSON object ``{"type": "export", "ok": bool, ...}`` which the
installer locates by scanning stdout lines from the end. Diagnostics go to
stderr.
"""
import argparse
import hashlib
import json
import os
import sys

ENCODER_FILENAME = "mobileclip_blt.ts"


def parse_args(argv):
    """Pure argv parsing + validation (unit-tested without heavy deps)."""
    p = argparse.ArgumentParser(prog="export_yoloe11.py")
    p.add_argument("--pt", required=True, help="path to yoloe-11s-seg.pt")
    p.add_argument(
        "--encoder",
        required=True,
        help=f"path to the pre-fetched {ENCODER_FILENAME} text encoder",
    )
    p.add_argument("--out", required=True, help="destination .onnx path")
    p.add_argument(
        "--classes",
        required=True,
        help='comma-separated frozen vocabulary, e.g. "person"',
    )
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--opset", type=int, default=17)
    a = p.parse_args(argv)
    classes = [c.strip() for c in a.classes.split(",") if c.strip()]
    if not classes:
        raise ValueError("--classes must name at least one class")
    if os.path.basename(a.encoder) != ENCODER_FILENAME:
        # ultralytics resolves the encoder by this exact relative filename
        # (cwd-relative); any other basename would trigger a 572MB re-download.
        raise ValueError(
            f"--encoder must point at a file named {ENCODER_FILENAME!r}, "
            f"got {a.encoder!r}"
        )
    return {
        "pt": a.pt,
        "encoder": a.encoder,
        "out": a.out,
        "classes": classes,
        "imgsz": a.imgsz,
        "opset": a.opset,
    }


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _validate_onnx(path: str, imgsz: int, n_classes: int) -> None:
    """Load the exported graph with onnxruntime and assert the exact tensor
    contract libitrack/detect.py depends on. This is the real integrity gate
    (the output sha can't be pinned)."""
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    if [int(d) for d in inp.shape] != [1, 3, imgsz, imgsz]:
        raise RuntimeError(
            f"exported ONNX input shape {inp.shape} != [1, 3, {imgsz}, {imgsz}]"
        )
    outs = sess.run(None, {inp.name: np.zeros((1, 3, imgsz, imgsz), np.float32)})
    c = outs[0].shape[1]
    expected = 4 + n_classes + 32  # 4 bbox + nc class scores + 32 mask coeffs
    if c != expected:
        raise RuntimeError(
            f"exported ONNX output0 channel dim {c} != {expected} "
            f"(4 + {n_classes} classes + 32 mask coeffs)"
        )


def run(cfg: dict) -> dict:
    for key in ("pt", "encoder"):
        if not os.path.isfile(cfg[key]):
            raise FileNotFoundError(f"--{key} file not found: {cfg[key]}")

    # ultralytics' asset resolver checks for 'mobileclip_blt.ts' relative to
    # the CURRENT WORKING DIRECTORY; chdir next to the pre-fetched copy so it
    # is found and never re-downloaded.
    os.chdir(os.path.dirname(os.path.abspath(cfg["encoder"])))

    from ultralytics import YOLOE
    from ultralytics.utils import SETTINGS

    SETTINGS.update({"sync": False})  # no analytics network calls

    import ultralytics

    m = YOLOE(cfg["pt"], verbose=False)
    m.set_classes(cfg["classes"], m.get_text_pe(cfg["classes"]))
    exported = m.export(
        format="onnx",
        opset=cfg["opset"],
        simplify=False,
        imgsz=cfg["imgsz"],
        device="cpu",
    )
    _validate_onnx(str(exported), cfg["imgsz"], len(cfg["classes"]))

    out = os.path.abspath(cfg["out"])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.abspath(str(exported)) != out:
        os.replace(str(exported), out)

    return {
        "type": "export",
        "ok": True,
        "out": out,
        "sha256": _sha256(out),
        "sizeBytes": os.path.getsize(out),
        "classes": cfg["classes"],
        "imgsz": cfg["imgsz"],
        "opset": cfg["opset"],
        "ultralytics": ultralytics.__version__,
    }


def main(argv) -> int:
    try:
        result = run(parse_args(argv))
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — surface everything as protocol JSON
        print(
            json.dumps(
                {"type": "export", "ok": False, "error": f"{type(e).__name__}: {e}"}
            )
        )
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

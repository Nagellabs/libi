"""export_yoloe11.py argument parsing/validation (pure — no heavy deps).

The heavy export path (ultralytics + CLIP + mobileclip) is exercised for real
by the tracking-pyenv installer and is deliberately NOT run from a unit test.
"""
import pytest

from export_yoloe11 import ENCODER_FILENAME, parse_args


def _argv(**over):
    base = {
        "pt": "/models/yoloe-11s-seg.pt",
        "encoder": f"/models/.build/{ENCODER_FILENAME}",
        "out": "/models/yoloe11.onnx",
        "classes": "person",
    }
    base.update(over)
    argv = []
    for k, v in base.items():
        argv += [f"--{k}", v]
    return argv


def test_parse_args_happy_path():
    cfg = parse_args(_argv())
    assert cfg["classes"] == ["person"]
    assert cfg["imgsz"] == 640
    assert cfg["opset"] == 17
    assert cfg["encoder"].endswith(ENCODER_FILENAME)


def test_parse_args_multiple_classes_and_overrides():
    cfg = parse_args(_argv(classes=" person , face ") + ["--imgsz", "320", "--opset", "18"])
    assert cfg["classes"] == ["person", "face"]
    assert cfg["imgsz"] == 320
    assert cfg["opset"] == 18


def test_parse_args_rejects_empty_classes():
    with pytest.raises(ValueError, match="at least one class"):
        parse_args(_argv(classes=" , "))


def test_parse_args_rejects_wrong_encoder_filename():
    # ultralytics resolves the encoder by this exact cwd-relative filename;
    # any other basename would trigger a 572MB re-download at export time.
    with pytest.raises(ValueError, match=ENCODER_FILENAME):
        parse_args(_argv(encoder="/models/.build/encoder.ts"))

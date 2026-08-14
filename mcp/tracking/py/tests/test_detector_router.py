# mcp/tracking/py/tests/test_detector_router.py
import numpy as np
import pytest

from libitrack.detector_router import FROZEN_VOCAB, select_detector


class _FrozenSpy:
    def __init__(self, classes): self.classes = classes
    def detect(self, f): return np.zeros((0, 6), np.float32)
    def detect_seg(self, f): return np.zeros((0, 6), np.float32), []


class _EagerSpy:
    def __init__(self, anchor_crop, anchor_box_xyxy, classes):
        self.anchor_box_xyxy = anchor_box_xyxy
        self.classes = classes
    def detect(self, f): return np.zeros((0, 6), np.float32)
    def detect_seg(self, f): return np.zeros((0, 6), np.float32), []


def _job():
    return {"videoPath": "/nonexistent.mp4", "anchors": [{"time": 0.0, "bbox": [10, 20, 30, 40]}]}


def test_person_routes_frozen():
    d = select_detector(["person"], _job()["anchors"], _job(),
                        frozen_factory=lambda classes: _FrozenSpy(classes),
                        eager_factory=lambda **k: pytest.fail("eager must not run for person"))
    assert isinstance(d, _FrozenSpy) and d.classes == ["person"]


def test_face_class_routes_frozen():
    d = select_detector(["face"], _job()["anchors"], _job(),
                        frozen_factory=lambda classes: _FrozenSpy(classes),
                        eager_factory=lambda **k: pytest.fail("eager must not run for face"))
    assert isinstance(d, _FrozenSpy)


def test_novel_class_routes_eager_with_anchor_crop():
    captured = {}
    def eager(anchor_crop, anchor_box_xyxy, classes):
        captured["box"] = anchor_box_xyxy
        captured["crop_shape"] = anchor_crop.shape
        captured["classes"] = classes
        return _EagerSpy(anchor_crop, anchor_box_xyxy, classes)
    d = select_detector(["backpack"], _job()["anchors"], _job(),
                        frozen_factory=lambda classes: pytest.fail("frozen must not run for novel"),
                        eager_factory=eager,
                        _crop_reader=lambda vp, t, bbox: (np.zeros((40, 30, 3), np.uint8),
                                                          [bbox[0], bbox[1], bbox[0]+bbox[2], bbox[1]+bbox[3]]))
    assert isinstance(d, _EagerSpy)
    assert captured["classes"] == ["backpack"]
    assert captured["box"] == [10, 20, 40, 60]
    assert captured["crop_shape"] == (40, 30, 3)


def test_mixed_classes_any_novel_routes_eager():
    d = select_detector(["person", "backpack"], _job()["anchors"], _job(),
                        frozen_factory=lambda classes: pytest.fail("must not be frozen"),
                        eager_factory=lambda **k: _EagerSpy(k["anchor_crop"], k["anchor_box_xyxy"], k["classes"]),
                        _crop_reader=lambda vp, t, bbox: (np.zeros((4, 4, 3), np.uint8), [0, 0, 4, 4]))
    assert isinstance(d, _EagerSpy)


def test_novel_class_without_anchors_raises_runtimeerror():
    with pytest.raises(RuntimeError, match="anchor"):
        select_detector(["backpack"], [], {"videoPath": "x", "anchors": []},
                        frozen_factory=lambda classes: _FrozenSpy(classes),
                        eager_factory=lambda **k: _EagerSpy(None, None, None))


def test_frozen_vocab_is_the_single_source():
    assert "person" in FROZEN_VOCAB and "face" in FROZEN_VOCAB
    assert "backpack" not in FROZEN_VOCAB


def test_earliest_anchor_is_the_prompt_source():
    seen = {}
    def reader(vp, t, bbox):
        seen["t"] = t
        return (np.zeros((2, 2, 3), np.uint8), [0, 0, 2, 2])
    select_detector(
        ["backpack"],
        [{"time": 5.0, "bbox": [1, 1, 2, 2]}, {"time": 1.0, "bbox": [3, 3, 4, 4]}],
        {"videoPath": "x", "anchors": []},
        frozen_factory=lambda classes: pytest.fail("must be eager"),
        eager_factory=lambda **k: _EagerSpy(k["anchor_crop"], k["anchor_box_xyxy"], k["classes"]),
        _crop_reader=reader,
    )
    assert seen["t"] == 1.0  # earliest-time anchor picked, not the first in the list


def test_empty_classes_defaults_to_frozen_person():
    d = select_detector(
        [], _job()["anchors"], _job(),
        frozen_factory=lambda classes: _FrozenSpy(classes),
        eager_factory=lambda **k: pytest.fail("empty classes must default to frozen person"),
    )
    assert isinstance(d, _FrozenSpy) and d.classes == ["person"]

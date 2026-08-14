"""TransNetV2 ONNX shot/scene-cut detection.

Resolves the TransNetV2 ONNX from the tracking model dir (honoring
``LIBI_TRACK_MODELS``; default ``~/.libi/models/tracking``; filename =
the ``transnetv2`` ``dest`` from ``models.json`` => ``transnetv2.onnx``).

Real model contract (verified, see SPIKE-NOTES.md):
  input  ``frames_uint8``        shape ``[1, 100, 27, 48, 3]``  dtype ``tensor(uint8)``
  output ``frame_probabilities`` shape ``[1, 100]``             dtype ``tensor(float)``

Frames are fed as **uint8** RGB resized to 48x27 in a sliding window of 100.
The plan skeleton's ``.astype(np.float32)`` is wrong for this model -- the
ONNX declares a uint8 input; we honor the real ``sess.get_inputs()`` dtype.
"""
import cv2
import numpy as np
import onnxruntime as ort

from libitrack.models import model_path as _model_path

# dest filename for the `transnetv2` model entry in models.json
_MODEL_FILENAME = "transnetv2.onnx"

# TransNetV2 fixed input geometry (SPIKE-NOTES "## TransNetV2"):
_WINDOW = 100
_H = 27
_W = 48

# onnxruntime tensor-type string -> numpy dtype, so we feed exactly what the
# model declares (this model: tensor(uint8)).
_ORT_TO_NP = {
    "tensor(uint8)": np.uint8,
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
    "tensor(int8)": np.int8,
    "tensor(int32)": np.int32,
    "tensor(int64)": np.int64,
}


def _model() -> ort.InferenceSession:
    return ort.InferenceSession(
        _model_path(_MODEL_FILENAME), providers=["CPUExecutionProvider"]
    )


def _frames(video_path: str):
    """Decode the whole video to RGB 48x27 uint8 frames + fps."""
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    buf = []
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        # BGR -> RGB, then resize to the model's 48x27 input.
        buf.append(cv2.resize(fr[:, :, ::-1], (_W, _H)))
    cap.release()
    if not buf:
        return np.empty((0, _H, _W, 3), dtype=np.uint8), fps
    return np.asarray(buf, dtype=np.uint8), fps


def detect_shots(video_path: str, threshold: float = 0.5):
    """Detect shot boundaries; return contiguous, non-overlapping ranges.

    Each shot is ``{"start": <s>, "end": <s>}`` in seconds (rounded to ms).
    Always returns >= 1 shot; the first shot always starts at ``0.0``.
    """
    frames, fps = _frames(video_path)
    n = len(frames)
    if n == 0:
        return [{"start": 0.0, "end": 0.0}]

    sess = _model()
    in_meta = sess.get_inputs()[0]
    iname = in_meta.name
    # Honor the model's real declared input dtype (uint8 for this model);
    # fall back to uint8 if the type string is unrecognized.
    np_dtype = _ORT_TO_NP.get(in_meta.type, np.uint8)

    preds = np.zeros(n, dtype=np.float32)
    for i in range(0, n, _WINDOW):
        chunk = frames[i : i + _WINDOW]
        if len(chunk) < _WINDOW:
            pad = np.repeat(chunk[-1:], _WINDOW - len(chunk), axis=0)
            chunk = np.concatenate([chunk, pad], axis=0)
        feed = chunk[None].astype(np_dtype, copy=False)
        out = sess.run(None, {iname: feed})[0].reshape(-1)
        take = min(_WINDOW, n - i)
        preds[i : i + take] = out[:take]

    # A "cut" frame index ends the current shot at that boundary.
    cuts = [idx for idx, p in enumerate(preds) if p >= threshold]
    bounds = [0] + cuts + [n]
    shots = []
    prev = 0
    for b in bounds[1:]:
        if b <= prev:
            continue
        shots.append(
            {"start": round(prev / fps, 3), "end": round(b / fps, 3)}
        )
        prev = b
    return shots or [{"start": 0.0, "end": round(n / fps, 3)}]

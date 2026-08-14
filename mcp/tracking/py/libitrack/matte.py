"""MatAnyone mask-guided video matting (sidecar method "matte").

Given a video path, a time range, and a subject seed (a pixel box from
libi.ground_target, or None = "auto" -> largest person instance), runs
MatAnyone consistent-memory alpha propagation and writes ONE 8-bit
grayscale alpha PNG per source frame into ``job["outputDir"]``.

Sidecar protocol contract (track_runner.py): stdout is JSON-LINES ONLY —
pixels go to disk (``f%06d.png``), never the protocol channel.

Job (stdin JSON):
  { "method": "matte", "videoPath": str, "range": {"start": s, "end": s},
    "outputDir": str, "seedBox": [x, y, w, h] | None,
    "seedMaskPath": str | None, "maxDim": int (default 1080),
    "warmup": int (default 10) }

Result line:
  { "type": "result", "samples": [], "framerate": <src_fps>,
    "outputDir": str, "frameCount": int, "device": "cpu"|"mps",
    "msPerFrame": float }
  (+ "error": "no_seed_instance" with frameCount 0 when the seed step
  finds no subject — an HONEST empty result, never a full-frame matte.)

Seed derivation: reuses the instance masks Detector.detect_seg ALREADY
decodes from YOLOE-11s-seg (previously discarded) — no new inference
model for the seed. ``seedMaskPath`` (grayscale PNG, >127 = subject)
overrides derivation entirely (the future SAM2/external-seed path).
"""
import os
import time

import cv2
import numpy as np


# ── Alpha-coverage gate ──────────────────────────────────────────────────────
# `frameCount` alone is a COUNT, which this codebase treats as necessary but
# NOT sufficient. The spike proved why: a mask-convention bug produced 181
# alpha PNGs that were entirely zero — every count-based check passed and the
# cutout rendered nothing. These thresholds turn "how much did the matte
# actually keep" into a blocking signal, mirroring what summarizeTrack's flags
# do for tracking.

#: Mean alpha coverage at or below this is an empty matte (subject lost).
#: 0.2% of an 854x480 frame is ~820px (~28x28) — far below any usable subject;
#: measured talking-head subjects sit at 4%-30%.
EMPTY_COVERAGE_MAX = 0.002

#: Mean alpha coverage at or above this means nothing was removed — compositing
#: it over a new background silently shows the ORIGINAL scene.
FULL_FRAME_COVERAGE_MIN = 0.98


def classify_coverage(mean_coverage):
    """Flags for a matte's mean alpha coverage (0.0-1.0). Empty list == clean.

    Pure and torch-free so the honesty rule is unit-testable without the
    inference stack. Boundaries are clean-side inclusive: exactly at a
    threshold is not a failure, only beyond it.
    """
    if mean_coverage < EMPTY_COVERAGE_MAX:
        return ["empty_matte"]
    if mean_coverage > FULL_FRAME_COVERAGE_MIN:
        return ["full_frame_matte"]
    return []


def pick_seed_instance(dets, masks, seed_box=None):
    """Pick the seed instance from ``Detector.detect_seg`` output.

    Args:
        dets: (N, 6) float array [x1, y1, x2, y2, conf, cls].
        masks: list of N full-frame bool arrays (frame-pixel coords).
        seed_box: [x, y, w, h] in frame pixels, or None for "auto"
            (largest-area detection wins).

    Returns:
        The chosen bool mask, or None when there are no detections or the
        seed box overlaps nothing meaningfully (best IoU < 0.1).
    """
    if len(masks) == 0:
        return None
    if seed_box is None:
        areas = [float((d[2] - d[0]) * (d[3] - d[1])) for d in dets]
        return masks[int(np.argmax(areas))]
    sx, sy, sw, sh = (float(v) for v in seed_box)
    sb = [sx, sy, sx + sw, sy + sh]
    best_i, best = -1, 0.0
    for i, d in enumerate(dets):
        ix = max(0.0, min(float(d[2]), sb[2]) - max(float(d[0]), sb[0]))
        iy = max(0.0, min(float(d[3]), sb[3]) - max(float(d[1]), sb[1]))
        inter = ix * iy
        ua = (
            (float(d[2]) - float(d[0])) * (float(d[3]) - float(d[1]))
            + sw * sh
            - inter
        )
        iou = inter / ua if ua > 0 else 0.0
        if iou > best:
            best, best_i = iou, i
    return masks[best_i] if best_i >= 0 and best >= 0.1 else None


def _pick_device():
    """mps when available (Apple Silicon), else cpu. LIBI_MATTE_DEVICE
    overrides (the spike's A/B speed lever)."""
    import torch

    forced = os.environ.get("LIBI_MATTE_DEVICE")
    if forced in ("cpu", "mps"):
        return forced
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _load_processor(device):
    """Load MatAnyone from the local models dir (offline), falling back to
    the HF hub id (dev convenience; production always has the local copy —
    the tracking-pyenv installer provisions it)."""
    import torch

    import matanyone.model.matanyone as matanyone_model
    from matanyone.inference.inference_core import InferenceCore
    from matanyone.model.matanyone import MatAnyone

    from libitrack.models import models_dir

    # Upstream gotcha: matanyone/model/matanyone.py caches a MODULE-LEVEL
    # ``device = get_default_device()`` at import time and force-moves
    # pixel_mean/pixel_std to it inside encode_image — ignoring the device
    # the net actually lives on. Forcing cpu on an mps-capable machine
    # (LIBI_MATTE_DEVICE=cpu) crashes with a cross-device subtract unless
    # we re-point that global at OUR device.
    matanyone_model.device = torch.device(device)

    local = os.path.join(models_dir(), "matanyone")
    src = local if os.path.isdir(local) else "PeiqingYang/MatAnyone"
    net = MatAnyone.from_pretrained(src)
    net = net.eval()
    return InferenceCore(net, device=device)


def _derive_seed_mask(frame, seed_box):
    """First-frame binary seed via the YOLOE-seg masks detect_seg already
    decodes. Returns bool HxW mask or None."""
    from libitrack.detect import Detector

    det = Detector(classes=["person"])
    dets, masks = det.detect_seg(frame)
    return pick_seed_instance(dets, masks, seed_box)


def run_matte(job: dict, emit) -> int:
    """Run MatAnyone over ``job["range"]`` and write alpha PNGs.

    ``emit`` is the sidecar's JSON-line writer (pipeline._emit). Returns 0.
    Processes EVERY source frame in range (no fps decimation) so the alpha
    sequence is frame-aligned with the source for the ffmpeg alphamerge.
    """
    import torch

    vp = job["videoPath"]
    r0 = float(job["range"]["start"])
    r1 = float(job["range"]["end"])
    out_dir = job["outputDir"]
    seed_box = job.get("seedBox")
    seed_mask_path = job.get("seedMaskPath")
    max_dim = int(job.get("maxDim") or 1080)
    warmup = int(job.get("warmup") or 10)

    os.makedirs(out_dir, exist_ok=True)
    device = _pick_device()

    cap = cv2.VideoCapture(vp)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_est = max(1, int(round((r1 - r0) * src_fps)))

    processor = None
    scale = None
    coverage_sum = 0.0
    frame_count = 0
    fidx = -1
    t_start = None

    with torch.inference_mode():
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            fidx += 1
            t = fidx / src_fps
            if t < r0:
                continue
            if t > r1:
                break

            h0, w0 = frame.shape[:2]
            if scale is None:
                scale = min(1.0, max_dim / float(max(w0, h0)))
            small = (
                cv2.resize(
                    frame,
                    (int(w0 * scale), int(h0 * scale)),
                    interpolation=cv2.INTER_AREA,
                )
                if scale < 1.0
                else frame
            )
            rgb = np.ascontiguousarray(small[:, :, ::-1])
            image_t = (
                torch.from_numpy(rgb).permute(2, 0, 1).float().to(device) / 255.0
            )

            if processor is None:
                # First in-range frame: derive / load the seed, prime memory.
                if seed_mask_path:
                    sm = cv2.imread(seed_mask_path, cv2.IMREAD_GRAYSCALE)
                    seed = sm > 127 if sm is not None else None
                    if seed is not None and seed.shape != frame.shape[:2]:
                        seed = (
                            cv2.resize(
                                seed.astype(np.uint8),
                                (w0, h0),
                                interpolation=cv2.INTER_NEAREST,
                            )
                            > 0
                        )
                else:
                    seed = _derive_seed_mask(frame, seed_box)
                if seed is None or not bool(seed.any()):
                    cap.release()
                    emit(
                        {
                            "type": "result",
                            "samples": [],
                            "framerate": src_fps,
                            "outputDir": out_dir,
                            "frameCount": 0,
                            "device": device,
                            "msPerFrame": 0.0,
                            "error": "no_seed_instance",
                        }
                    )
                    return 0
                if scale < 1.0:
                    seed = (
                        cv2.resize(
                            seed.astype(np.uint8),
                            (small.shape[1], small.shape[0]),
                            interpolation=cv2.INTER_NEAREST,
                        )
                        > 0
                    )
                # MatAnyone expects the first-frame mask 0..255-valued
                # (the official demo feeds Image.convert("L") un-normalized;
                # a 0/1 binary mask memorizes an EMPTY matte → all-zero
                # alpha, verified empirically). Pre-treat with the demo's
                # dilate+erode (r=10) — the official smoothing for
                # segmentation-derived seeds like our YOLOE masks.
                from matanyone.utils.inference_utils import (
                    gen_dilate,
                    gen_erosion,
                )

                seed_255 = seed.astype(np.uint8) * 255
                seed_255 = gen_erosion(gen_dilate(seed_255, 10, 10), 10, 10)
                mask_t = torch.from_numpy(seed_255.astype(np.float32)).to(
                    device
                )

                processor = _load_processor(device)
                t_start = time.monotonic()
                output_prob = processor.step(image_t, mask_t, objects=[1])
                for _ in range(warmup):
                    output_prob = processor.step(image_t, first_frame_pred=True)
            else:
                output_prob = processor.step(image_t)

            m = processor.output_prob_to_mask(output_prob)
            alpha_small = (
                (m.float().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            )
            alpha = (
                cv2.resize(alpha_small, (w0, h0), interpolation=cv2.INTER_LINEAR)
                if scale < 1.0
                else alpha_small
            )
            cv2.imwrite(os.path.join(out_dir, f"f{frame_count:06d}.png"), alpha)
            # Accumulate mean alpha (0..1) for the honesty gate. One float per
            # frame — the per-frame cost is a single numpy mean over the alpha
            # plane, negligible next to inference.
            coverage_sum += float(alpha.mean()) / 255.0
            frame_count += 1

            if frame_count % 5 == 0:
                emit(
                    {
                        "type": "progress",
                        "done": frame_count,
                        "total": total_est,
                        "unit": "frames",
                    }
                )

    cap.release()
    elapsed = (time.monotonic() - t_start) if t_start is not None else 0.0
    ms_per_frame = (elapsed * 1000.0 / frame_count) if frame_count else 0.0
    if frame_count % 5 != 0:
        emit(
            {
                "type": "progress",
                "done": frame_count,
                "total": total_est,
                "unit": "frames",
            }
        )
    mean_coverage = (coverage_sum / frame_count) if frame_count else 0.0
    emit(
        {
            "type": "result",
            "samples": [],
            "framerate": src_fps,
            "outputDir": out_dir,
            "frameCount": frame_count,
            "device": device,
            "msPerFrame": round(ms_per_frame, 1),
            # Honesty gate: mean fraction of each frame the matte kept, plus
            # any blocking flags. A healthy frameCount with empty_matte is the
            # exact silent failure the spike hit (181 all-zero PNGs).
            "coverage": round(mean_coverage, 5),
            "flags": classify_coverage(mean_coverage),
        }
    )
    return 0

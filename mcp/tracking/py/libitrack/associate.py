"""BoxMOT 19 BoT-SORT association wrapper with per-shot reset.

Wraps the real installed boxmot 19 API (verified end-to-end -- see
SPIKE-NOTES.md, "## BoxMOT API"). The plan's old
``BotSort(reid_weights=..., device=..., half=...)`` shape is OBSOLETE and
must not be used; the verified facts are:

  - import: ``from boxmot.trackers.botsort.botsort import BotSort``
    (NO top-level ``from boxmot import BotSort``).
  - ``BotSort.__init__`` takes ``reid_model`` (a backend OBJECT), ``with_reid``,
    ``frame_rate`` and threshold kwargs -- NO ``reid_weights`` / ``device`` /
    ``half``.
  - ``BotSort.update(dets, img) -> TrackResults`` -- an ``np.ndarray`` subclass,
    raw shape Nx8 ``[x1, y1, x2, y2, track_id, conf, cls, det_ind]`` (track id
    at column 4).
  - ReID wiring: ``BotSort(reid_model=...)`` wants the BACKEND that has
    ``.get_features`` -- that is ``ReID(...).model``, NOT the ``ReID`` wrapper
    itself (the wrapper has no ``get_features``).

ReID is best-effort: if the PyTorch ReID backend cannot be constructed
(e.g. no network to auto-download ``osnet_x0_25_msmt17.pt``, gdown missing),
this logs a warning to STDERR and falls back to a motion-only BoT-SORT so the
wrapper still works.

stdout is reserved for the sidecar JSON protocol -- this module NEVER prints
to stdout; all diagnostics go to stderr via ``logging``.
"""
import logging
import sys

import numpy as np
from boxmot.trackers.botsort.botsort import BotSort

from libitrack.detector_base import CONF_FLOOR_DEFAULT

# Log to stderr only -- stdout is the sidecar JSON channel.
logger = logging.getLogger("libitrack.associate")
if not logger.handlers:
    _h = logging.StreamHandler(sys.stderr)
    _h.setFormatter(logging.Formatter("%(levelname)s libitrack.associate: %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)

# boxmot's default ReID model; auto-downloaded from its model zoo on first use.
_REID_WEIGHTS = "osnet_x0_25_msmt17.pt"


def _build_reid_backend():
    """Build boxmot's PyTorch ReID backend, or return None on any failure.

    Returns the backend object held at ``ReID(...).model`` (it has the
    ``.get_features`` method BoT-SORT needs). Any exception -- missing network
    for the .pt auto-download, missing gdown, etc. -- is caught, logged to
    stderr, and surfaced as ``None`` so the caller falls back to motion-only.
    """
    try:
        from boxmot.reid import ReID

        wrapper = ReID(weights=_REID_WEIGHTS, device="cpu", half=False)
        return wrapper.model
    except Exception as e:  # noqa: BLE001 -- best-effort; any failure -> fallback
        logger.warning(
            "ReID backend unavailable (%s: %s); falling back to motion-only "
            "BoT-SORT",
            type(e).__name__,
            e,
        )
        return None


class Associator:
    """Per-shot BoT-SORT association wrapper.

    The orchestrator constructs one Associator and calls :meth:`reset` at every
    shot boundary so track ids never bleed across cuts.

    Args:
        with_reid:   When True (default), attempt to attach boxmot's PyTorch
                     appearance ReID backend. Best-effort: if it cannot be
                     built (no network, etc.) a stderr warning is logged and the
                     tracker runs motion-only. When False, BoT-SORT runs
                     motion-only and no ReID object is built at all.
        frame_rate:  Source FPS, forwarded to BoT-SORT's track buffer math.
    """

    def __init__(self, with_reid: bool = True, frame_rate: int = 30) -> None:
        self.with_reid = with_reid
        self.frame_rate = frame_rate
        self.frame_count = 0
        self.tracker = self._build_tracker()

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _build_tracker(self) -> BotSort:
        """Construct a fresh BoT-SORT per the verified boxmot 19 signature.

        ReID is best-effort: when requested but the backend can't be built we
        degrade to motion-only rather than raising. The successfully-built
        backend is exposed as ``self.reid_backend`` so the pipeline can reuse
        the SAME OSNet object for appearance-gating (never a second model)."""
        # The associator must never gate STRICTER than the detectors' emit
        # floor. BoxMOT's stock defaults (track_high_thresh=0.5,
        # new_track_thresh=0.6) mean a detection in [CONF_FLOOR_DEFAULT, 0.5)
        # can NEVER birth a track — it only participates in the second
        # association stage against tracks that never exist. On ordinary
        # low-res footage (320x240, person conf ~0.26-0.43) the detector saw
        # the subject on EVERY frame while the pipeline emitted an
        # all-invisible track (task-39 Bug 1; empirically reproduced +
        # verified fixed on real 320x240 footage). Aligning both birth gates
        # to the shared floor removes the dead band regardless of which
        # detector backend produced the confidence. Binding correctness does
        # not lean on detection confidence: anchors, the degenerate-box veto,
        # and the ReID appearance gate keep spurious low-conf tracklets from
        # ever being bound.
        #
        # KNOWN CONSEQUENCE — BYTE's second association stage now receives an
        # EMPTY set every frame: with track_high == the detectors' emit floor,
        # the (track_low, track_high) band the second stage consumes contains
        # no detections. This is deliberate and measured, not an oversight:
        #  - In boxmot 19, occlusion RECOVERY (re-finding a Lost track) lives
        #    in the FIRST stage — its pool is active + lost_stracks, matched
        #    by min(IoU-cost, ReID-cost) at match_thresh 0.8 (IoU >= 0.2).
        #    The second stage matches only still-Tracked unmatched tracks,
        #    IoU-only at 0.5, and EXCLUDES Lost tracks — it is keep-alive,
        #    not recovery.
        #  - The [floor, 0.5) band is therefore not discarded; it moves to a
        #    strictly more capable matcher (looser IoU gate + ReID + Lost
        #    pool). Measured on real footage (occlusion clip + two low-res
        #    variants): reacquire-after-occlusion time and per-frame
        #    visibility were IDENTICAL to stock where stock worked at all.
        #  - The alternative — lowering the DETECTOR emit floor to ~0.1 so
        #    the second stage is fed again — measured byte-identical on all
        #    of the above, while adding junk detections to the IoU-only
        #    (appearance-blind) second stage and to every other detection
        #    consumer (ground_target candidates). Do not "restore" it
        #    without new footage-level evidence.
        thresh = dict(
            track_high_thresh=CONF_FLOOR_DEFAULT,
            new_track_thresh=CONF_FLOOR_DEFAULT,
        )
        self.reid_backend = None
        if self.with_reid:
            backend = _build_reid_backend()
            if backend is not None:
                self.reid_backend = backend
                return BotSort(
                    reid_model=backend,
                    with_reid=True,
                    frame_rate=self.frame_rate,
                    **thresh,
                )
        # Either with_reid=False, or ReID backend construction failed.
        return BotSort(with_reid=False, frame_rate=self.frame_rate, **thresh)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(self, dets: np.ndarray, frame: np.ndarray) -> np.ndarray:
        """Advance the tracker by one frame and return tracked boxes.

        Args:
            dets:  Nx6 float32 ``[x1, y1, x2, y2, conf, cls]`` detections. An
                   empty input is normalised to a ``(0, 6)`` float32 array so
                   BoT-SORT still ages/coasts existing tracks.
            frame: HxWx3 uint8 image.

        Returns:
            A plain ``np.ndarray`` of shape Nx8
            ``[x1, y1, x2, y2, track_id, conf, cls, det_ind]`` -- the track id
            is at column index 4 (``int(out[i][4])``). Returns the underlying
            ndarray of BoT-SORT's ``TrackResults`` (subclass coerced to a plain
            array via ``np.asarray``).
        """
        if dets is None or dets.size == 0:
            dets = np.zeros((0, 6), np.float32)
        else:
            dets = np.ascontiguousarray(dets, dtype=np.float32)

        res = self.tracker.update(dets, frame)
        self.frame_count += 1
        return np.asarray(res)

    def reset(self) -> None:
        """Drop all track state at a shot boundary.

        Rebuilds the tracker (a fresh BoT-SORT with the same ReID setting) and
        zeroes the frame counter. Called by the orchestrator at every shot cut
        so ids never persist across scenes.
        """
        self.tracker = self._build_tracker()
        self.frame_count = 0

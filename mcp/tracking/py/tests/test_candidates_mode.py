# mcp/tracking/py/tests/test_candidates_mode.py
"""`method:"candidates"` mode emits the competing tracklets (the identity
ambiguity the absolute appearance gate is provably blind to) instead of
collapsing to one bound id.

Harness mirrors test_pipeline_target_sim.py / test_pipeline_appearance_gate.py:
the real fixture clip drives the frame loop while a monkeypatched detector +
associator + ReID backend synthesize a 2-rival scenario — one track matching
the anchor template (Lisa), one persistently dissimilar (the cameraman).
"""
import contextlib
import io
import json
import pathlib

import numpy as np
import pytest

from libitrack import pipeline

from .conftest import FACE_FIXTURE, FACE_FIXTURE_MISSING_REASON

pytestmark = pytest.mark.skipif(
    not FACE_FIXTURE.exists(), reason=FACE_FIXTURE_MISSING_REASON
)

REPO = pathlib.Path(__file__).resolve().parents[4]
FIX = str(REPO / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4")

# Two persistent boxes for the whole window — the appearance-blind case
# (mirrors the real lisa-12 repro: a cameraman in matching clothing whose
# appearance is CLOSE to the subject, so the absolute τ gate cannot reject
# him — only rival comparison can). LISA sits on the anchor; CAM partially
# overlaps it (the historical wrong-bind), distinct-but-similar appearance.
LISA = [50.0, 200.0, 90.0, 130.0]   # xywh, h=130 -> high-sim appearance
CAM = [70.0, 210.0, 100.0, 145.0]   # xywh, h=145 -> similar-but-lower sim


def _xyxy(box):
    x, y, w, h = box
    return [x, y, x + w, y + h]


class _Backend:
    """Graded appearance keyed on box width — the realistic appearance-blind
    case: both rivals resemble the Lisa-seeded template, but LISA more so.
    Width <95 (LISA) -> the template direction; width >=95 (CAM) -> a
    similar-but-distinct direction (cosine ~0.928 to LISA's). The anchor
    box (w=90) seeds the template along LISA's direction, so over the window
    meanTargetSim ~ {LISA: ~1.0, CAM: ~0.93} — gap < DELTA_AMBIG(0.20) and
    both >= TAU-DELTA(0.58): the exact ambiguity the absolute gate is blind
    to (cf. SPIKE-NOTES measured Lisa 0.8054 vs cameraman 0.6301)."""

    def get_features(self, xyxys, img):
        out = []
        for b in np.asarray(xyxys, dtype=np.float32).reshape(-1, 4):
            w = b[2] - b[0]
            v = np.zeros(8, dtype=np.float32)
            if w < 95.0:                     # LISA / the anchor box
                v[0] = 1.0
            else:                            # CAM — similar-but-lower sim
                v[0] = 1.0
                v[1] = 0.4                   # cosine to [1,0,..] ~ 0.928
            out.append(v)
        return np.asarray(out, dtype=np.float32)


class _Det:
    """Both rivals visible every frame — a persistent 2-subject ambiguity."""

    def __init__(self, classes, **_):
        pass

    def detect(self, frame):
        lx1, ly1, lx2, ly2 = _xyxy(LISA)
        cx1, cy1, cx2, cy2 = _xyxy(CAM)
        return np.array(
            [
                [lx1, ly1, lx2, ly2, 0.95, 0.0],
                [cx1, cy1, cx2, cy2, 0.92, 0.0],
            ],
            dtype=np.float32,
        )

    def detect_seg(self, frame):
        return self.detect(frame), []


class _Assoc:
    """Pass both detections through with stable BoT-SORT ids (LISA always
    detected first -> id 1; CAM second -> id 2 — two persistent subjects).
    reid_backend keys appearance on box width (see _Backend)."""

    def __init__(self, **_):
        self.reid_backend = _Backend()

    def update(self, dets, frame):
        rows = []
        for i, d in enumerate(dets):
            x1, y1, x2, y2 = d[:4]
            tid = i + 1  # detection order -> stable id (LISA=1, CAM=2)
            rows.append([x1, y1, x2, y2, tid, float(d[4]), 0.0, 0.0])
        return np.array(rows, dtype=np.float32)

    def reset(self):
        pass


def _run(monkeypatch):
    monkeypatch.setattr(
        pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}]
    )
    monkeypatch.setattr(pipeline, "Detector", _Det)
    monkeypatch.setattr(pipeline, "Associator", lambda *a, **k: _Assoc())
    job = {
        "videoPath": FIX,
        "fps": 25.0,
        "range": {"start": 0.0, "end": 5.0},
        "method": "candidates",
        "classes": ["person"],
        # Anchor sits on Lisa so the template is seeded from her appearance.
        "anchors": [
            {"time": 0.0, "bbox": LISA},
            {"time": 4.0, "bbox": LISA},
        ],
    }
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        pipeline.run_segment(job)
    lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    return [l for l in lines if l["type"] == "result"][-1]


def test_candidates_mode_emits_ranked_competing_tracklets(monkeypatch):
    res = _run(monkeypatch)
    assert res["type"] == "result"
    # Non-breaking: the normal-track payload stays an empty list.
    assert res["samples"] == []
    cands = res["candidateTracklets"]
    assert len(cands) >= 2
    c = cands[0]
    assert set(c) >= {"candidateId", "perFrame", "meanTargetSim", "frameCount"}
    assert c["perFrame"] and set(c["perFrame"][0]) >= {"t", "bbox"}
    assert len(c["perFrame"][0]["bbox"]) == 4  # [x, y, w, h]
    assert c["frameCount"] == len(c["perFrame"])
    # Ranked best-appearance-match first when ReID is available.
    assert cands[0]["meanTargetSim"] >= cands[-1]["meanTargetSim"]
    # The Lisa-seeded template ⇒ the top candidate is the higher-sim one.
    assert cands[0]["meanTargetSim"] > cands[-1]["meanTargetSim"]


# ── C1 regression: cross-shot raw-id-collision must NOT fuse subjects ──
# Two shots; one distinct subject per shot, spatially disjoint (zero mutual
# IoU). assoc.reset() restarts BoxMOT raw ids at 1 at the cut, so BOTH
# subjects carry raw id 1 in their own shot. Pass-1's same-raw-id stitch
# (no IoU check) would fuse them into ONE candidate across the cut — wrong.
# After the epoch gate, the post-cut subject can only join via Pass-2's
# IoU bridge; zero IoU ⇒ a NEW candidate is minted ⇒ two separate subjects.
SHOT_A = [40.0, 60.0, 80.0, 120.0]    # xywh, lives only in shot A (left)
SHOT_B = [420.0, 60.0, 80.0, 120.0]   # xywh, lives only in shot B (right)


class _DetTwoShot:
    """Exactly ONE detection per frame; which subject depends on the time
    (shot A: t<2.5 ⇒ SHOT_A; shot B: t>=2.5 ⇒ SHOT_B). The frame loop has
    no time handle, so the associator stamps the active subject instead."""

    active = {"box": SHOT_A}

    def __init__(self, classes, **_):
        pass

    def detect(self, frame):
        x1, y1, x2, y2 = _xyxy(self.active["box"])
        return np.array([[x1, y1, x2, y2, 0.95, 0.0]], dtype=np.float32)

    def detect_seg(self, frame):
        return self.detect(frame), []


class _AssocTwoShot:
    """Single subject per frame, ALWAYS raw id 1 (BoxMOT renumber from 1
    after reset()). Switches which subject is 'active' at the t≈2.5 cut so
    each shot has a spatially disjoint subject both numbered raw id 1."""

    def __init__(self, **_):
        self.reid_backend = None  # motion-only is irrelevant to C1
        self._n = -1

    def update(self, dets, frame):
        # ~25 fps over a 5s clip → ~125 processed frames; flip at the
        # midpoint so shot A ≈ first half, shot B ≈ second half.
        self._n += 1
        if self._n >= 62:
            _DetTwoShot.active = {"box": SHOT_B}
        else:
            _DetTwoShot.active = {"box": SHOT_A}
        rows = []
        for d in dets:
            x1, y1, x2, y2 = d[:4]
            rows.append([x1, y1, x2, y2, 1, float(d[4]), 0.0, 0.0])
        return np.array(rows, dtype=np.float32)

    def reset(self):
        pass


def _run_two_shot(monkeypatch):
    _DetTwoShot.active = {"box": SHOT_A}
    # TWO shots with a hard cut at 2.5s.
    monkeypatch.setattr(
        pipeline,
        "detect_shots",
        lambda vp: [{"start": 0.0, "end": 2.5}, {"start": 2.5, "end": 5.0}],
    )
    monkeypatch.setattr(pipeline, "Detector", _DetTwoShot)
    monkeypatch.setattr(
        pipeline, "Associator", lambda *a, **k: _AssocTwoShot()
    )
    job = {
        "videoPath": FIX,
        "fps": 25.0,
        "range": {"start": 0.0, "end": 5.0},
        "method": "candidates",
        "classes": ["person"],
        # One anchor per subject so BOTH have anchor-IoU coverage and
        # qualify for retention in the motion-only path.
        "anchors": [
            {"time": 1.0, "bbox": SHOT_A},
            {"time": 4.0, "bbox": SHOT_B},
        ],
    }
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        pipeline.run_segment(job)
    lines = [
        json.loads(l) for l in out.getvalue().splitlines() if l.strip()
    ]
    return [l for l in lines if l["type"] == "result"][-1]


def test_cross_shot_raw_id_collision_does_not_fuse_subjects(monkeypatch):
    """Two spatially disjoint subjects, each raw id 1 in its own shot, must
    NOT be fused into one candidate across the cut. FAILS pre-C1-fix (the
    same-raw-id Pass-1 fires across the reset with no IoU check) — the two
    subjects collapse to len(retained)==1 ⇒ candidateTracklets:[]. PASSES
    post-fix: epoch gate forces cross-reset matching through Pass-2's IoU
    bridge; zero mutual IoU ⇒ two separate candidates ⇒ ambiguous."""
    res = _run_two_shot(monkeypatch)
    assert res["type"] == "result"
    assert res["samples"] == []
    cands = res["candidateTracklets"]
    # Two disjoint subjects each on an anchor ⇒ motion-only ambiguous ⇒
    # both surfaced. Pre-fix they fuse to ONE → [] (not ambiguous).
    assert len(cands) == 2, (
        f"expected 2 distinct subjects, got {len(cands)} "
        f"(pre-C1-fix this fuses to 0 via [] not-ambiguous)"
    )
    # Each candidate is one subject's run: their boxes never overlap.
    box_a = cands[0]["perFrame"][0]["bbox"]
    box_b = cands[1]["perFrame"][0]["bbox"]
    # x-ranges disjoint (SHOT_A x∈[40,120], SHOT_B x∈[420,500]).
    xs = sorted([box_a[0], box_b[0]])
    assert xs[1] - xs[0] > 200, (box_a, box_b)


# ── I1.2: ReID-off path — meanTargetSim None, retention via anchor IoU ──
def _run_reid_off(monkeypatch):
    """Same persistent 2-rival scene as the canonical test but with the
    associator's reid_backend = None ⇒ ReidFeatures.enabled is False ⇒
    template stays empty ⇒ reid_on is False (motion-only fallback)."""
    monkeypatch.setattr(
        pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}]
    )
    monkeypatch.setattr(pipeline, "Detector", _Det)

    class _AssocNoReid(_Assoc):
        def __init__(self, **_):
            self.reid_backend = None  # ⇒ ReidFeatures disabled

    monkeypatch.setattr(
        pipeline, "Associator", lambda *a, **k: _AssocNoReid()
    )
    job = {
        "videoPath": FIX,
        "fps": 25.0,
        "range": {"start": 0.0, "end": 5.0},
        "method": "candidates",
        "classes": ["person"],
        # Anchor sequence overlapping BOTH rivals so each has coverage ≥ X.
        "anchors": [
            {"time": 0.0, "bbox": LISA},
            {"time": 2.0, "bbox": CAM},
            {"time": 4.0, "bbox": LISA},
        ],
    }
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        pipeline.run_segment(job)
    lines = [
        json.loads(l) for l in out.getvalue().splitlines() if l.strip()
    ]
    return [l for l in lines if l["type"] == "result"][-1]


def test_candidates_reid_off_uses_anchor_coverage(monkeypatch):
    res = _run_reid_off(monkeypatch)
    assert res["type"] == "result"
    cands = res["candidateTracklets"]
    # ≥2 retained each with anchorIoUCoverage ≥ X ⇒ motion-only ambiguous.
    assert len(cands) >= 2
    # ReID disabled ⇒ every candidate's meanTargetSim is null.
    for c in cands:
        assert c["meanTargetSim"] is None
    # Ranking went via anchorIoUCoverage desc (sim is None for all): the
    # frameCounts/order are produced by the coverage sort, not the sim sort.
    assert all(c["frameCount"] == len(c["perFrame"]) for c in cands)


# ── I1.3: not identity-ambiguous ⇒ candidateTracklets == [] ──
# One strong on-anchor subject + one far rival whose appearance is well
# below TAU and whose mean-sim gap to the strong one is ≥ DELTA_AMBIG(0.20):
# the window is NOT ambiguous, so [] must be emitted (guards the
# "every window flagged ambiguous" failure mode).
STRONG = [50.0, 200.0, 88.0, 128.0]   # on the anchor, w<95 ⇒ sim ~1.0
FARRIVAL = [400.0, 60.0, 100.0, 150.0]  # far, w>=95 ⇒ low-sim direction


class _DetClear:
    def __init__(self, classes, **_):
        pass

    def detect(self, frame):
        s = _xyxy(STRONG)
        f = _xyxy(FARRIVAL)
        return np.array(
            [
                [s[0], s[1], s[2], s[3], 0.95, 0.0],
                [f[0], f[1], f[2], f[3], 0.92, 0.0],
            ],
            dtype=np.float32,
        )

    def detect_seg(self, frame):
        return self.detect(frame), []


class _BackendClear:
    """STRONG (w<95) → template direction (sim ~1.0). FARRIVAL (w>=95) →
    near-orthogonal (sim ~0.24) so the mean-sim gap ≥ DELTA_AMBIG."""

    def get_features(self, xyxys, img):
        out = []
        for b in np.asarray(xyxys, dtype=np.float32).reshape(-1, 4):
            w = b[2] - b[0]
            v = np.zeros(8, dtype=np.float32)
            if w < 95.0:
                v[0] = 1.0
            else:
                v[0] = 0.25
                v[1] = 1.0   # cosine to [1,0,..] ≈ 0.243 → big gap
            out.append(v)
        return np.asarray(out, dtype=np.float32)


class _AssocClear(_Assoc):
    def __init__(self, **_):
        self.reid_backend = _BackendClear()


def test_candidates_not_ambiguous_emits_empty(monkeypatch):
    monkeypatch.setattr(
        pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}]
    )
    monkeypatch.setattr(pipeline, "Detector", _DetClear)
    monkeypatch.setattr(
        pipeline, "Associator", lambda *a, **k: _AssocClear()
    )
    job = {
        "videoPath": FIX,
        "fps": 25.0,
        "range": {"start": 0.0, "end": 5.0},
        "method": "candidates",
        "classes": ["person"],
        "anchors": [
            {"time": 0.0, "bbox": STRONG},
            {"time": 4.0, "bbox": STRONG},
        ],
    }
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        pipeline.run_segment(job)
    lines = [
        json.loads(l) for l in out.getvalue().splitlines() if l.strip()
    ]
    res = [l for l in lines if l["type"] == "result"][-1]
    # Strong-vs-far gap ≥ DELTA_AMBIG ⇒ NOT ambiguous ⇒ empty list.
    assert res["candidateTracklets"] == []


# ── I1.4: a noise tracklet far from the anchor is dropped by retention ──
# 3 tracklets: LISA (on anchor, high sim), CAM (overlaps anchor, mid sim),
# NOISE (far from anchor AND meanSim < TAU-DELTA_AMBIG). NOISE qualifies on
# NEITHER retention clause ⇒ excluded.
NOISE = [560.0, 30.0, 60.0, 90.0]   # far from anchor; w<95 but see backend


class _DetNoise:
    def __init__(self, classes, **_):
        pass

    def detect(self, frame):
        l = _xyxy(LISA)
        c = _xyxy(CAM)
        n = _xyxy(NOISE)
        return np.array(
            [
                [l[0], l[1], l[2], l[3], 0.95, 0.0],
                [c[0], c[1], c[2], c[3], 0.92, 0.0],
                [n[0], n[1], n[2], n[3], 0.90, 0.0],
            ],
            dtype=np.float32,
        )

    def detect_seg(self, frame):
        return self.detect(frame), []


class _BackendNoise:
    """Keyed on x-origin so NOISE (x=560) is forced to a low-sim direction
    regardless of its width: LISA→sim~1.0, CAM→sim~0.93, NOISE→sim~0.24
    (< TAU-DELTA_AMBIG = 0.58) AND it never overlaps the anchor."""

    def get_features(self, xyxys, img):
        out = []
        for b in np.asarray(xyxys, dtype=np.float32).reshape(-1, 4):
            x = b[0]
            v = np.zeros(8, dtype=np.float32)
            if x >= 500.0:                  # NOISE
                v[0] = 0.25
                v[1] = 1.0                  # cosine ≈ 0.243 → below floor
            elif (b[2] - b[0]) < 95.0:      # LISA
                v[0] = 1.0
            else:                            # CAM
                v[0] = 1.0
                v[1] = 0.4
            out.append(v)
        return np.asarray(out, dtype=np.float32)


class _AssocNoise:
    def __init__(self, **_):
        self.reid_backend = _BackendNoise()

    def update(self, dets, frame):
        rows = []
        for i, d in enumerate(dets):
            x1, y1, x2, y2 = d[:4]
            rows.append([x1, y1, x2, y2, i + 1, float(d[4]), 0.0, 0.0])
        return np.array(rows, dtype=np.float32)

    def reset(self):
        pass


def test_candidates_noise_tracklet_excluded(monkeypatch):
    monkeypatch.setattr(
        pipeline, "detect_shots", lambda vp: [{"start": 0.0, "end": 5.0}]
    )
    monkeypatch.setattr(pipeline, "Detector", _DetNoise)
    monkeypatch.setattr(
        pipeline, "Associator", lambda *a, **k: _AssocNoise()
    )
    job = {
        "videoPath": FIX,
        "fps": 25.0,
        "range": {"start": 0.0, "end": 5.0},
        "method": "candidates",
        "classes": ["person"],
        "anchors": [
            {"time": 0.0, "bbox": LISA},
            {"time": 4.0, "bbox": LISA},
        ],
    }
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        pipeline.run_segment(job)
    lines = [
        json.loads(l) for l in out.getvalue().splitlines() if l.strip()
    ]
    res = [l for l in lines if l["type"] == "result"][-1]
    cands = res["candidateTracklets"]
    # LISA + CAM are ambiguous (both retained, gap < DELTA_AMBIG); NOISE
    # fails BOTH retention clauses (sim < TAU-DELTA AND anchorCov < X) ⇒
    # never surfaced. So at most 2 candidates, and none far-right.
    assert len(cands) == 2
    for c in cands:
        assert c["perFrame"][0]["bbox"][0] < 400.0, c["perFrame"][0]

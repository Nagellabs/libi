# Tracking repair reference

Read the part you need; `SKILL.md` has the loop.

## Stabilisation: which lever for which wobble

`libi.tracked_overlay` action `verify` renders exactly what the user sees (anchors and stabilisation applied), so judge by its
frames, not by the raw samples.

- **Ballooning or pulsing big and small is a SIZE problem, not a position problem.** Re-anchoring fixes where
  the box is, not how large it flaps. The default `sizeMode:"stabilized"` clamps outlier boxes and
  median-smooths width and height over about 7 frames, holding the edge the offset implies (the head top for an
  overlay above the subject) fixed while resizing. If it still pulses:
  `libi.tracked_overlay({ action: "update", overlayId, sizeMode:"stabilized", maxBoxScale:1.3 })` (lower is stricter;
  default 1.75). Re-anchor only when the box is on the wrong subject or is a grossly wrong detection, and make
  corrective anchors subject-sized. `sizeMode:"raw"` is debugging only.
- **Bouncing up and down on the right subject is a position problem.** The default `positionMode:"stabilized"`
  (a One-Euro filter on the box centre, applied at read time so existing overlays get it with no re-track) and
  the size stabilisation above already remove most of it. It roughly halves the wobble; what remains is the
  subject's real micro-motion, and a perfectly frozen overlay would lag the real motion, so do not chase zero or
  stack filters. Do not re-anchor, do not touch `smoothing`, and do not rewrite the content's draw code unless
  that code genuinely animates position. If an overlay bounces anyway, check it was not set to
  `positionMode:"raw"` and restore it with `libi.tracked_overlay` action `update`; `raw` is the opt-out for a deliberately
  bouncy look.
- **`smoothing` is interpolation, not a denoiser.** It runs between samples that are already stabilised and
  cannot remove jitter. Keep `linear`; a spline mode overshoots at direction changes and can make a wobble worse.

## Identity ambiguity: list, then pick

Symptom: `identity_switch_suspected` that re-anchoring and `compute_segment` keep failing to clear, or a
wrong-subject lock with a high `targetSim` (a cameraman in matching clothes scoring about 0.92). The appearance
gate cannot tell the subjects apart, so more anchors will not help.

1. `libi.track({ action: "list_candidates", trackId, range })` returns the competing tracklets, each drawn in its own
   colour across sampled times, inline in the result.
2. View the frames, decide which candidate is the real subject.
3. `libi.track({ action: "pick_candidate", trackId, range, candidateId })` locks it. This writes an agent segment that owns the
   window regardless of the appearance and position thresholds; only a user's manual drag outranks it.

Do not `skip_segment` and do not blind re-anchor for this case.

## Agent anchors persist and converge

When `compute_segment` runs on an existing track with corrective `anchors`, the in-range anchors are saved
to a transparent channel and re-seed every later re-track of that window. At render the engine's per-segment head
track is trusted where it succeeded; an agent anchor overrides only where the engine is provably wrong (re-bound to
another subject) or locally lost, and then it places a head-sized box at head level. So a dense pile of anchors on
an already-correct window is harmless; what matters is the windows where the engine is on the wrong subject. These
anchors are not user-visible or user-removable, and manual anchors outrank them. A re-track that finds no visible
subject never overwrites earlier samples; your anchors still serve as the lost-window fallback.

## Manual re-anchors

A user dragging a tracked overlay's art in the preview writes a manual anchor on the track, and the system
already starts a seeded re-track of the containing segment. On a `[manual-edit]` chat message that work is
running: do not recompute the window. Manual anchors are the highest-trust signal there is. `list_segments`
returns `manualAnchors` and `manualAnchorCount`. If a track has manual anchors and the user says it is still off,
a seeded `compute_segment` over the containing segment (it merges manual anchors itself) is the first repair
move, before `ground_target` or a method switch. Never clear manual anchors; the recompute tools merge them with
priority stored manual, then explicit `anchors`, then analysis-derived.

## Attaching to a flagged track on purpose

`libi.tracked_overlay` action `add` refuses a flagged track. After you have inspected `summary.issues` and, say, skipped the
lost range, `acknowledgeQualityIssues:true` lets the attach through. Never set it to get past an unlooked-at
flag.

## Tracks made elsewhere

If the user ran tracking somewhere else and has per-frame boxes, write them into libi's store with
`libi.track({ action: "update_result", fileId, method: "external-mcp:<name>", framerate, samples })`, where `samples` are
`{ t, x, y, w, h, confidence, visible }` in pixel coordinates, the shape `compute` produces. It
takes boxes only: the track store has no mask field. A cutout is `libi.remove_background`.

## Housekeeping

`libi.track({ action: "list", fileId })` lists a file's tracks; `libi.track({ action: "delete", trackId })` removes one (overlays that
reference it stop rendering until updated or removed). "File must be assigned to a piece" means
`libi.assign_file` first. An overlay in the wrong place is a `fit` and `scale` mismatch for the track kind, not a
reason to use `fit:"rect"`. A wrong subject in a crowd is solved with denser, varied anchors and a recompute of
that window.

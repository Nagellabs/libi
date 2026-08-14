---
name: using-object-tracking
description: Pin any visual element (emoji, text, image, video, JS draw fn, blur/pixelate/mask) to a moving subject across a video — face or object tracking, censor a face, follow a product. "smiley on her face", "blur the license plate", "logo on his shirt", "name tag follows him", "pixelate the plate".
when_to_use: When the user asks to follow / cover / blur / mask / sticker / label a moving person or object in a video, or when a prior track has bad sections to fix. This is the single source of truth for tracking + the diagnostic loop.
---

# Using Object Tracking

> This skill is the ONE place for tracking + overlay-pinning. It absorbed the
> old `tracking-overlay` skill — do not look for a separate overlay skill.

> **Engine install:** If a tracking tool returns `tracking_engine_not_installed`,
> follow the libi-tracking install plan: call `libi.get_install_plan` (id
> `libi-tracking`), drive the install, then `libi.verify_install` until
> `ok:true`, then retry. **Do NOT gate on `chromium` / `mediapipe-vision`** —
> those are the legacy MediaPipe path, not the default `yoloe+botsort` engine.

The tracker is **shot-segmented and composable**. You drive it; it reports
per-segment quality and *why* a segment failed. Never hand-guess pixel boxes.

If the overlay is **static** (same rect the whole clip — not following
anything), use `libi.add_overlay({ kind: "text" })` / `libi.add_overlay({ kind: "image" })` etc. instead;
no tracking needed.

## Deliver what the user asked — never a workaround

If the user asks for "a smiley **on her face**", the deliverable is a
face-sized emoji **on the face for the whole clip**. When tracking is imperfect
you have exactly two honest moves:

1. **Fix the track** (the repair loop below — re-anchor the bad window, switch
   method, skip a genuinely-impossible range), or
2. **Tell the user** what's still imperfect and ask how they want to proceed.

You may **NOT** silently substitute a degraded result to dodge a quality
problem. Specifically forbidden as "workarounds":

- `fit:"rect"` with a fixed size to stop ballooning — it detaches the overlay
  from the head and parks it on the body. Size is already capped by the
  renderer; pick `fit` by track kind (below) and tune `scale`, never `fit:"rect"`.
- Moving / shrinking / repositioning the overlay off what was requested to hide
  tracker drift.
- Declaring success on `summary.issues` alone — for multi-person footage it must
  also pass the step-5 identity spot-check.

A smaller-but-correct result the user didn't ask for is still wrong.

## Zero output is an ENGINE failure — never silently keyframe

If `compute_object_track` (or `compute_track_segment`) returns
`summary.total === 0`, a `no_output` flag, or an "ENGINE PRODUCED NO TRACK"
`qualityWarning`, the pipeline bound the subject in **0 frames**. This is an
ENGINE MISS, not a subject-absent window — do NOT treat it like a `low_visibility`
or `skip_segment` case, and do NOT proceed to `add_tracked_overlay`.

**Forbidden fallback:** silently hand-animating a keyframe code overlay
(`ground_target` per-frame + `add_keyframe`) to fake the requested follow. That
substitutes a degraded result the user didn't ask for and hides a broken engine.

**Do this instead:**
1. **Isolate.** Run `ground_target` at 2-3 in-clip timestamps. If it returns the
   subject at high confidence while the full track is empty, the DETECTOR sees
   the subject but the PIPELINE failed to bind it — a local engine failure on
   this footage (portrait / edge-hugging subjects are a known class).
2. **Try an alternate method.** `compute_track_segment({ method: "sot" })` runs
   single-object template tracking — it bypasses the detector/associate/bind
   path entirely and locks onto the anchor region, so it often succeeds exactly
   where `yoloe+botsort` bound nothing.
3. **If it still fails, SURFACE it.** Tell the user the local tracker could not
   follow the subject on this clip and offer the paid SAM2 provider
   (`refine_track_with_sam2`) or ask how they'd like to proceed. Never pretend
   the track succeeded.

## Local engine is ALWAYS the default tracker

`libi.compute_object_track` (local, free, runs on the user's machine) is the
default and the right choice for essentially every request. **SAM2 via fal.ai
is NOT a tracker and is NOT auto-selected** — it is opt-in *paid mask
refinement* applied to an existing box track only when a pixel-precise mask is
needed (object replacement / matting) AND the user approved the cost. Never
route to `compute_object_track_providers` / `refine_track_with_sam2` just
because `fal-ai` is configured.

## Generalized detector (arbitrary non-person objects)

The local engine tracks **any object the user names**, not just people.
Naming a non-person target (e.g. `classes:["backpack"]` on
`compute_object_track`, or a non-person `compute_track_segment`) **auto-routes
server-side to the generalized YOLOE-VP detector** — you do NOT change
`method`; person/face stay on the fast frozen path automatically. It is still
the local, free engine — never route to `compute_object_track_providers` /
SAM2 for this.

It ships **with** the tracking engine (same `tracking-pyenv` install). If a
tracking tool reports the engine is not installed, follow the **libi-tracking
install plan** (`libi.get_install_plan` id `libi-tracking` → drive install →
`libi.verify_install` until `ok:true` → retry) — the SAME loop as for the
person path; there is no separate generalized-detector install step, no new
error kind.

This generalizes *detection* to arbitrary items. It does **NOT** solve
identity: among similar instances the right one is still picked by
`anchors[]` + the normal ground→anchor→verify repair loop and the B+C
appearance safeguards. A non-person track that drifts/switches is repaired
exactly like a person track (re-anchor the bad window) — the generalized
detector is not a substitute for re-anchoring.

## Default flow

1. **Anchors — make the FIRST track as good as possible. Dense beats sparse.**
   - **If the video has frame analysis** with bboxes for the subject
     (`people[].name`/`objects[].name` + `bbox`), pass
     **`derivedFromSubjectName:"<name>"`** (or `derivedFromItemName`) to
     `compute_object_track`. This seeds an anchor at *every* analyzed frame
     across the whole clip, which keeps the tracker locked on the right subject
     through occlusions / turns / crowds.
   - **A single `ground_target` anchor is a FALLBACK**, only when no analysis
     bboxes exist. One anchor is fragile: after the subject turns away or is
     briefly occluded the tracker can silently latch onto a *different* person
     (e.g. a cameraman) for the rest of the clip. If you must ground manually,
     ground at **2–3 spread-out times**, not one.
   - **Show the grounded frame for approval.** If `ground_target` returns
     `annotatedFileId`, render it inline:
     `![grounded](/api/files/by-id/<annotatedFileId>/content)` and ask the user
     to confirm the box is on the intended subject (or pick a number) BEFORE
     `compute_object_track`. If `annotatedFileId` is absent (no detections or
     annotation unavailable), list the numbered candidates in text and still ask
     the user to confirm/pick before tracking. One confirmation here prevents the
     whole wrong-subject repair loop.
   - You may combine both: manual anchors win on time collisions, derived
     anchors fill the gaps.
2. **Compute.** `compute_object_track({ fileId, derivedFromSubjectName:"<name>" })`
   (preferred) or `{ fileId, anchors:[…] }`. Auto shot-segments + tracks each
   shot. Read the returned `summary` (`perSegment`, `visibleRanges`,
   `lostRanges`, `flags`, **`issues`**) and **`qualityWarning`**.
3. **MANDATORY quality gate — do NOT attach an overlay on a flagged track.** If
   `summary.issues` is non-empty (or `qualityWarning` is present) the track is
   wrong somewhere even if `visible` is high. Each `issues[]` entry has a `kind`
   and a precise `range`:
   - `identity_switch_suspected` — the box jumped to a different subject (the
     cameraman bug). Re-anchor from the switch time onward: `ground_target` in
     `range` (or use the analysis bbox there) → `compute_track_segment({
     trackId, range:{start, end:<clip end>}, method:"yoloe+botsort",
     anchors:[…] })`.
   - `oversized_box_while_visible` — bad detection that makes the overlay
     balloon. Re-seed that `range` with a tight anchor via
     `compute_track_segment`, or `skip_segment` if untrackable there.
   - `edge_pinned` — followed a background person/cameraman at the frame edge.
     Re-anchor or `skip_segment` that `range`.
   Repair the exact `range` only — recomputing a segment never touches the others.
4. **Also diagnose `lost`/low-`visible` segments** the same way: consult frame
   analysis for that range (or `analysis_extract_frames` just there), understand
   WHY (back-to-camera? occlusion? scene cut?), then:
   - Truly not visible → `skip_segment({ trackId, range, reason })` (honest;
     renders nothing).
   - Wrong subject / better seed → `ground_target` in range →
     `compute_track_segment({ …, method:"yoloe+botsort", anchors:[…] })`.
   - **Identity ambiguity (≥2 confident similar subjects — appearance gate
     non-discriminative):** symptom is `identity_switch_suspected` that
     re-anchor/`compute_track_segment` keeps failing to clear, OR a
     wrong-subject lock with high `targetSim` (e.g. cameraman in matching
     clothing scoring ~0.92). Call
     `libi.list_identity_candidates({ trackId, range })` — it returns the
     competing tracklets with per-candidate colored frames inline in the tool
     result (each candidate drawn in a distinct palette color across sampled
     times, like the grounding-approval frames). Inspect the frames, identify
     which candidate is the correct subject, then call
     `libi.pick_candidate({ trackId, range, candidateId })` to lock it. This
     writes a `provenance:"agent"` segment that **authoritatively owns the
     window** regardless of the appearance/positional thresholds — it is
     strictly stronger than the τ/positional gates (while a user manual drag
     still outranks it). Do **NOT** `skip_segment` and do **NOT** blind
     re-anchor for this case; only a visual candidate pick resolves it.
   - Describable arbitrary object → `method:"yoloe-text", classes:["red soda can"]`. (note: a non-person class on compute_object_track now also auto-routes to the generalized detector — manual method:"yoloe-text" is the explicit-override form).
   - One instance a detector misses → `method:"sot"` with a tight anchor.
5. **Verify the RESULT visually — MANDATORY, and loop until it's right.**
   `summary.issues:[]` is necessary but NOT sufficient: the flags catch *abrupt*
   failures but NOT a *slow* drift onto a similar nearby subject. You MUST look
   at the rendered overlay before attaching.

   Call **`libi.verify_tracked_overlay`** (pre-attach form:
   `{ fileId, trackId, content, fit, scale?, smoothing? }`). It is read-only —
   it never re-tracks. It auto-selects the frames most likely to be wrong
   (every `summary.issues` range + every `lostRanges` range + the final
   seconds, sampled densely at the IN-BETWEEN non-anchor times — anchor frames
   are correct by construction and are excluded). It returns those frames as
   images plus, per frame, its `segmentId` / `method` / `status` /
   `isAnchorFrame` / `sampledRect` / `visible`, plus the track `summary`.

   **LOOK at the returned frames.** Judge the actual overlay: right subject?
   head-sized (not torso, not ballooned)? not lagging behind the motion? For
   every frame that is wrong — even with `issues:[]` — read its `segmentId`
   and fix that exact window:
   - genuinely not visible there → `libi.skip_segment({ trackId, range, reason })`
   - wrong subject / drift / loose → add a dense anchor at the bad time(s)
     (`ground_target` or analysis bbox) → `libi.compute_track_segment({
     trackId, range, method:"yoloe+botsort", anchors:[…] })`
   - too big (constant) → lower `scale` (and confirm `fit:"tight"` for a face track)

   **Ballooning / flashing is a SIZE problem, not a position problem.** If the
   overlay pulses big↔small or briefly fills the frame (often worst near the
   end), or `summary` lists `size_jitter`, do **NOT** re-anchor — re-anchoring
   fixes WHERE the box is, not its size jitter. The default `sizeMode:"stabilized"` already damps this — it clamps outlier
   boxes AND median-smooths the box size over time (~7 frames), holding the
   offset-implied stable edge (e.g. the head-top for an above-the-subject
   overlay) fixed while resizing; if it still pulses, tighten it:
   `libi.update_tracked_overlay({ overlayId, sizeMode:"stabilized", maxBoxScale:1.4 })`
   (lower `maxBoxScale`, e.g. 1.3, = stricter clamp). Only re-anchor when the
   box is on the wrong subject or is a grossly wrong detection; corrective
   anchors should themselves be subject-sized. `verify_tracked_overlay` renders
   exactly what the user sees (anchors + size policy applied), so trust the
   frames. `sizeMode:"raw"` disables stabilization (debug only).

   **Bouncing up/down on the RIGHT subject is a POSITION-jitter problem** —
   already damped by the default `positionMode:"stabilized"` (render-time
   One-Euro filter on the box center; existing overlays get it with no
   re-track). Size stabilization contributes too: the detector's box-height
   flap (head ↔ head+neck) used to inject bounce through the box center; the
   temporal size median with the stable-edge hold removes that at read time.
   Honest ceiling: stabilization roughly HALVES the wobble — the residual
   few-px motion is the subject's real micro-motion plus genuine tracker
   events, and a perfectly frozen overlay would lag real motion. Do not chase
   zero; do not add more filters. Do NOT re-anchor, do NOT change `smoothing` (interpolation, not
   denoising — `catmull-rom` can overshoot and look WORSE), and do NOT rewrite
   the content draw code unless its draw function genuinely animates position.
   If the user wants the raw bounce back:
   `libi.update_tracked_overlay({ overlayId, positionMode:"raw" })`.

   Then call `libi.verify_tracked_overlay` again over the same window and
   repeat. **Do NOT attach the overlay until every returned frame is visually
   correct.** Never close out on `issues:[]` alone.

   *User-directed entry:* if the user says "the tracking is off around mm:ss",
   call `libi.verify_tracked_overlay` with `focusRange:{start,end}` around that
   time, look at the frames, then re-anchor that window with
   `libi.compute_track_segment`.

   > **`compute_track_segment` anchors = the first-class force-track move.**
   > When you know where the subject is at a time (from analysis, a
   > `ground_target` pick, or the user pointing it out), passing that bbox as an
   > `anchors` entry to `libi.compute_track_segment` is the primary, direct
   > correction — not a last resort. This recomputes that segment transparently
   > and writes **no** user `ManualAnchor`: it does not appear in the preview's
   > re-anchor list and is not user-removable. Only the user dragging the
   > overlay art in the preview creates a removable `ManualAnchor`. Both paths
   > share one re-track core, so this never double-tracks.

### Skip-vs-re-anchor decision (the signal tells you which)

The signal itself disambiguates — never infer "fine" from `size_jitter` alone:

| Engine state in the window | Signal | Correct action |
|---|---|---|
| A confident bound box that stopped resembling the anchored subject (switched to a different person — the cameraman bug) | `identity_switch_suspected{range}` | **Re-anchor that exact window:** `ground_target` (or the analysis bbox) in `range` → `compute_track_segment({ trackId, range, method:"yoloe+botsort", anchors:[…] })`. **NEVER `skip_segment` for a `identity_switch_suspected` window** — skipping hides a wrong-subject lock and the overlay still renders the wrong subject around it. |
| No confident bound box at all — subject genuinely absent/occluded for the window (`visible:false`, no plausible detection) | `low_visibility` / lost range, **no** `identity_switch_suspected` | `skip_segment({ trackId, range, reason })` — the overlay honestly hides ~1s. Re-anchoring **cannot conjure a subject that isn't in frame**; do not pile anchors onto an empty window. |
| Box pulses big↔small but is on the right subject | `size_jitter` | Keep `sizeMode:"stabilized"` (clamp + temporal median; also removes the bounce size flap injects) / lower `maxBoxScale` via `update_tracked_overlay`. Do NOT re-anchor. |
| Overlay bounces up/down frame-to-frame while staying on the RIGHT subject | position jitter (no summary flag — visible in `verify_tracked_overlay` frames as a steady subject with a wobbling box) | Position stabilization is ON by default (`positionMode:"stabilized"`). If it still bounces, check the overlay isn't set to `positionMode:"raw"` and restore via `update_tracked_overlay`. Do NOT switch `smoothing` (interpolation ≠ denoising; `catmull-rom` overshoots and can make it WORSE), do NOT re-anchor, and do NOT blame the content draw code unless its draw function genuinely animates. |
| ≥2 confident similar subjects present — appearance gate non-discriminative (e.g. cameraman in matching clothing at targetSim ~0.92) | `identity_switch_suspected` that re-anchor keeps failing to clear, OR wrong-subject lock with high `targetSim` | **`list_identity_candidates` → `pick_candidate`** (NOT `skip_segment`, NOT blind re-anchor — those cannot resolve ambiguity when the engine can't tell the subjects apart by appearance). |

Rule of thumb: a confident bound box that no longer resembles the target ⇒ **switch ⇒ re-anchor**; no confident bound box at all ⇒ **gone ⇒ skip**; ambiguous similar subjects ⇒ **list_identity_candidates → pick**.

6. **Ensure the base video is on the timeline.** A tracked overlay renders
   ON TOP OF the base video. If the piece has no video layer for the source clip,
   the preview is blank even though the overlay and track data are correct.
   Before `add_tracked_overlay`, check the composition for a video overlay on
   that `fileId`; if there is none, add one with
   `libi.add_overlay({ pieceId, kind: "video", fileId })` (omit `rect` for a
   full-frame layer) and keep its `z` BELOW the tracked overlay's.
7. **Attach — pick `fit` by track kind. This matters; getting it wrong makes
   the emoji too big:**
   - **`objectKind:"face"` track → `fit:"tight"`, `scale` 1.0–1.1.** The emitted
     box ALREADY IS the head (silhouette-derived). `fit:"tight"` rides it
     exactly. **Do NOT use `fit:"head"` here** — `fit:"head"` *extends the box
     upward ~50%* to derive a head from a *body* box, so on an already-head box
     it inflates the emoji ~1.5× (the "emoji too big" bug). If it still looks
     slightly large, **lower `scale`** (e.g. 0.9) — never switch to `fit:"head"`.
   - **`objectKind:"object"` whole-person track → `fit:"head"`** (derives the
     head from the body box).
   - Never use `fit:"rect"` as an anti-balloon workaround.

## Analysis is the anchor source (prerequisite)

Tracking anchors come from `frame_v1` analysis. Before computing a track:

- **Invoke the `video-analysis` skill via the Skill tool** (reading it does not
  count) and follow it — it sets the keyframe density rule
  (`count ≈ ceil(durationSec/3)` for clips < 5 min, else `/10`; never a flat 8).
  A sparse 8-frame pass on a 40s clip is exactly why a track silently drifts to
  a duet partner between anchors.
- Call `libi.analysis_get({ fileId })`. Rebuild denser when `keyframes.length`
  is 0, there is no `ready` summary step, OR the analysis is sparser than the
  density rule.
- **Anchor signal:** populate `people[].id` AND `people[].name` with the same
  string (e.g. `id:"lisa", name:"Lisa"`) plus `people[].bbox` for every
  trackable subject. `analysis_search_frames` matches on `people[].id`.
- ⚠️ Saving frames REPLACES all existing keyframes — always pass the UNION of
  the existing keyframes (from `analysis_get`) + your new ones in one call.
- If automatic identification fails, ask the user for a timestamp where the
  subject is clearly visible + a short description, extract denser frames around
  it, describe + save, then retry.

Fallback when no derived bboxes exist:
`libi.analysis_search_frames({ fileId, subject:"<personId>" })` → pick 1–3
clear, varied frames → compose `anchors` (source-frame pixel coords, up to 100):
`[{ fileId, time, bbox:[x,y,w,h] }, …]`.

## Face/head overlays: `objectKind:"face"` (MANDATORY)

For any overlay that must sit on a face/head (emoji on a face, censor a face,
name tag on a head), pass **`objectKind:"face"`** to `compute_object_track` /
`compute_track_segment`.

It keeps the robust `yoloe+botsort` person track for SUBJECT IDENTITY (anchors +
ReID + the repair loop hold the right person — that is how you avoid the
cameraman/other-member) but emits the **HEAD sub-region derived from that
person's segmentation *silhouette*** instead of the body box. So the overlay:

- stays **head-sized** (never the torso, never balloons),
- does **not** drift onto a raised arm when she dances (an arm is a thin
  silhouette protrusion, not the head), and
- needs **no detectable frontal face** (silhouette-based — works
  back-to-camera / profile / concert footage where face detectors find nothing).

Recipe: dense subject anchors as for a normal person track (person-sized boxes,
NOT head boxes — the head is derived from the mask) →
`compute_object_track({ fileId, objectKind:"face", anchors|derivedFromSubjectName })`
→ attach with `fit:"tight"`, `scale` 1.0 (nudge **down** to 0.9 if large; never
`fit:"head"`, never `fit:"rect"`) → run the step-5 verify + repair loop
(identity is still anchors' job; head-refine only fixes size/placement).

`method:"sot"` is a true single-object template tracker for a specific
non-person instance a detector keeps missing within a window — it is **NOT the
face path** (it rescales/drifts on fast footage). For faces use
`objectKind:"face"`.

## Attach the overlay

```
libi.add_tracked_overlay({
  pieceId, trackId,
  startTime: 0,
  duration: <clip length>,            // mediaDuration from libi.list_files
  rect: { x:0, y:0, width:<compW>, height:<compH> },
  z: 10, opacity: 1,
  content: { kind:"emoji", char:"😀" },
  fit: "tight",                       // face track → tight; person track → head
  scale: 1.0,                         // face emoji ~1.0; tune per content
  smoothing: "linear",                // interpolation only — jitter is positionMode's job
})
```

`content` kinds: `{kind:"emoji",char}` · `{kind:"text",content,font,color,align}`
· `{kind:"image",fileId}` · `{kind:"video",fileId}` ·
`{kind:"code",drawFunction}` · `{kind:"effect",op:"blur"|"pixelate"|"mask"}`.

`scale` is a per-call multiplier — you decide per case (no global default):
emoji on a face ~1.0 (`fit:"tight"`, face track); blur/pixelate/mask 1.0–1.2
(`fit:"tight"`); constant-pixel badge ~1.0 (`fit:"rect"` + small `rect`);
object/product sticker ~1.0 (`fit:"tight"`). "make it bigger/smaller" →
`libi.update_tracked_overlay({ scale })`.

`smoothing` is sub-frame INTERPOLATION between already-stabilized samples —
NOT a denoiser; it cannot remove tracker jitter. `linear` (default — use it),
`catmull-rom` (spline; overshoots at direction changes — never use it to "fix
jitter"), `kalman` deprecated (≈linear). Positional bounce is removed by the
render-time default `positionMode:"stabilized"` (One-Euro filter on the box
center — steady when the subject is still, no lag when it moves; applied at
read time, so existing overlays get it with no re-track).
`positionMode:"raw"` opts out — only for a deliberately bouncy look.

**Progress / resume / cancel:** the tool streams live progress to the chat UI.
A failed mid-run call resumes from the last checkpoint on the next call with the
same `fileId`+`anchors`+`fps` (`forceNew:true` to restart). The Stop button
cancels gracefully (partial samples preserved). `libi.get_job_status({ jobId })`
/ `libi.cancel_job({ jobId })` for manual control.

## Multiple tracks / cleanup / failure modes

- Different subjects → one track each (own `label`). **Same subject, any number
  of overlays on ONE track:** call `add_tracked_overlay` multiple times with the
  same `trackId` and different `startTime`/`duration`/`content`/`z`. Each
  overlay follows the subject at its own clip time (the track is sampled at
  absolute clip time, not relative to the overlay's start), so "emoji on her
  face 0–5s, name tag on her face 20–25s" is two overlays on one track and both
  land correctly. Same subject, new content → reuse the trackId.
- `libi.list_tracks({ fileId })`; `libi.delete_track({ trackId })` (overlays
  referencing it stop rendering until updated/removed);
  `libi.list_track_segments({ trackId })` to verify every window is `ok` or
  `skipped` before attaching.
- "File must be assigned to a piece" → `libi.assign_file` first. Overlay in the
  wrong place → `fit`/`scale` mismatch by track kind (see step 7), not a reason
  to switch to `fit:"rect"`. Wrong subject in a crowd → anchors are how you
  disambiguate; add denser/varied anchors and recompute the bad window.

## Honest contract

`visible:false` / `status:"lost"` means the engine genuinely lost the subject —
believe it. `summary.issues` / `flags`
(`identity_switch_suspected`, `oversized_box_while_visible`, `edge_pinned`,
`full_canvas_while_visible`, `low_visibility`) mean the track is wrong in a
specific window — fix that window before attaching anything; never declare a
flagged track "clean." `identity_switch_suspected` now fires from appearance
divergence (the bound box stopped resembling the anchored subject), not just
a geometric teleport — it ALWAYS means re-anchor that exact window, NEVER
`skip_segment` (see "Skip-vs-re-anchor decision" above).
But the converse does NOT hold: **`issues:[]` is not proof of
correctness** — a slow drift onto a similar nearby person trips no flag. For
footage with other people near the subject, identity is only "confirmed" after
the step-5 spot-check. Prefer an honest `skip` over a bad track.

## Agent re-anchors persist and converge

When you `compute_track_segment` on an **existing** track with corrective
`anchors`, those in-range anchors are persisted to a transparent
`agentAnchors` channel and **re-seed every subsequent re-track of that
window** — that engine head re-track is the source of truth. At render the
engine's per-segment head track is **trusted where it succeeded**: an agent
anchor only overrides the render where the engine is *provably wrong*
(re-bound to a different subject) or *locally lost*, and even then it places a
**head**-sized box at head level — never the person-box torso. So a dense pile
of corrective anchors on an already-correct window is harmless (auto-trusted
to the engine track, no flicker); what matters is re-anchoring the windows
where the engine is on the **wrong subject**. These anchors are
**transparent** — not user-visible or user-removable, and **manual anchors
still outrank them**. A re-track that finds no visible subject will NOT
overwrite prior samples (never-make-worse); your persisted agent anchors still
apply as the lost-window fallback.

## Manual re-anchors (highest-trust user corrections)

A user can drag a tracked overlay's art in the preview to correct it. This
writes a `ManualAnchor` on the track (separate `manualAnchors` field) and the
SYSTEM already runs a seeded re-track of the containing segment. When you see
a `[manual-edit]` chat message: the work is ALREADY running — do NOT
recompute that window again. Manual anchors are the highest-trust signal in
the system (the user literally pointed at the subject).

- `list_track_segments` now returns `manualAnchors` + `manualAnchorCount`.
- If a track has manual anchors and the user reports it's still off, a seeded
  `compute_track_segment` over the containing segment (it auto-merges manual
  anchors) is the FIRST repair move — before ground_target or method switches.
- Never clear `manualAnchors`; recompute tools merge them automatically
  (priority: stored manual > explicit params.anchors > analysis-derived).

## SAM2 (paid, optional)

Only for precise masks (object replacement / matting), never as the primary
tracker. `refine_track_with_sam2({ trackId, range? })` refines an existing box
track. Requires explicit user approval (paid, fal.ai).

## Cross-references

- `video-analysis` — keyframe extraction + per-frame description; the required
  prerequisite for anchors. Invoke it (Skill tool) before tracking.
- `using-character-library` — if the subject is a catalog character/item, set
  `subjectId` on `compute_object_track` to associate the track for future reuse.

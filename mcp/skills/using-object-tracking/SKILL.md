---
name: using-object-tracking
description: "Pin an element to a moving subject: emoji, text, image, video, drawn shape, or a blur, pixelate or mask that follows a face or object ('smiley on her face', 'blur the license plate', 'name tag follows him'), plus fixing bad sections of a track. Not for cutting a subject out (removing-and-replacing-backgrounds)."
---

# Using object tracking

Done means the overlay sits on the subject the user named, at the right size, for the whole span they asked
for, and you have looked at rendered frames to confirm it. The tracker is local and free; libi has no paid
tracking provider. It produces boxes, not masks: a pixel-precise cutout is
`removing-and-replacing-backgrounds`. An overlay that stays in one place needs no tracking: use
`libi.add_overlay`.

The tracker is shot-segmented and composable. You drive it; it reports per-segment quality and why a segment
failed. Never hand-guess pixel boxes: take them from analysis or from `libi.track` action `ground_target`.

Two tools, each with an `action`: `libi.track` (`compute`, `compute_segment`, `list`, `list_segments`, `delete`,
`update_result`, `skip_segment`, `ground_target`, `list_candidates`, `pick_candidate`) and `libi.tracked_overlay`
(`add`, `update`, `verify`). A bare action name below is an action of `libi.track`.

Fine print for stabilisation, identity ambiguity, agent and manual anchors, and external tracks is in
`references/repair-reference.md`; read it when the loop below sends you there.

## Rules that do not bend

- **Deliver what was asked.** A face emoji sits on the face for the whole clip. When the track is imperfect you
  have two honest moves: fix the track, or tell the user what is still wrong and ask. Never swap in a degraded
  result: no fixed-size `fit:"rect"` to stop ballooning (it detaches the overlay from the head), no moving or
  shrinking the overlay to hide drift, no declaring success on `summary.issues` alone.
- **Zero output is an engine failure.** `summary.total === 0`, a `no_output` flag or an "ENGINE PRODUCED NO TRACK"
  warning means the pipeline bound the subject in no frames. It is not a subject-absent window, so do not
  `skip_segment` it and do not attach an overlay. Never fake the follow by hand-animating keyframes from
  `ground_target` positions. Instead: run `ground_target` at two or three in-clip times (if it finds the subject
  with high confidence while the track is empty, the detector sees it and the pipeline failed to bind it), then
  retry that window with `libi.track({ action: "compute_segment", method: "sot" })`, which template-tracks from an anchor and
  bypasses the detector. If that also fails, tell the user which methods you tried (`yoloe+botsort`, then `sot`)
  and ask: another clip, another segment, or manual anchors.
- **Look before you attach.** `issues: []` catches abrupt failures, not a slow drift onto a similar nearby
  person. You must view the rendered frames from `libi.tracked_overlay` action `verify`; do not attach until every
  returned frame is right.
- **A flagged window is repaired, never hidden.** Skip only a subject that is genuinely absent; a wrong-subject
  lock is re-anchored (table below).
- **Faces use `objectKind:"face"` and attach with `fit:"tight"`.**

## Flow

1. **Prerequisites.**
   - The base video must be on the timeline. A tracked overlay renders on top of it; with no video overlay for the
     source the preview is blank even though the data is right. Check the composition, and if needed
     `libi.add_overlay({ pieceId, kind: "video", fileId })` with a `z` below the tracked overlay's. A file must be
     assigned to a piece first (`libi.assign_file`).
   - Tracking tools returning `tracking_engine_not_installed` mean the lazy engine is not there yet:
     `libi.get_install_plan({ mcpId: "libi-tracking" })`, tell the user it is a 10-20 minute, ~2 GB download and
     get their yes, then `libi.install_tracking_engine`, `libi.verify_install` until `ok:true`, retry. Non-person
     detection ships in the same install.
   - Anchors come from frame analysis. Load the `video-analysis` skill and follow its keyframe density rule; a
     sparse pass on a long clip is how a track silently drifts to someone else between anchors. Check
     `libi.analysis_query({ action: "get", fileId })`; rebuild denser when there are no keyframes or too few. For each trackable
     subject save `people[].id` and `people[].name` as the same string plus `people[].bbox`.

2. **Anchors: make the first track as good as you can; dense beats sparse.**
   - With analysis bboxes, pass `derivedFromSubjectName` (or `derivedFromItemName` for objects) to
     `libi.track` action `compute`; it seeds an anchor at every analysed frame.
   - Without them, `libi.analysis_query({ action: "search_frames", fileId, subject })` for one to three clear, varied frames, or
     `libi.track` action `ground_target` at two or three spread-out times; a single anchor is fragile. Anchors are
     `{ fileId, time, bbox:[x,y,w,h] }` in source pixels, up to 100.
   - Show the grounded frame before tracking. If `ground_target` returns `annotatedFileId`, render
     `![grounded](/api/files/by-id/<annotatedFileId>/content)` and have the user confirm the box (or pick a
     number); with no annotation, or when images do not render in your client, list the numbered candidates in text. One confirmation here prevents the whole
     wrong-subject repair loop.

3. **Compute.** `libi.track({ action: "compute", fileId, objectKind, derivedFromSubjectName | anchors })`. A person
   is the default subject. For a face pass `objectKind:"face"` with person-sized anchors (not head boxes): the
   track keeps person identity and emits the head region from the person's silhouette, so it stays head-sized,
   ignores a raised arm and needs no frontal face. For a non-person subject name it with `classes:["backpack"]`;
   it routes to the generalized detector automatically (no `method` change, same engine). A describable object
   can also use `method:"yoloe-text"` on a segment, and `sot` suits one instance a detector keeps missing; `sot`
   is not the face path. The detector widens detection, not identity: among similar instances anchors decide.
   Read `summary` (`perSegment`, `visibleRanges`, `lostRanges`, `flags`, `issues`) and `qualityWarning`.

4. **Repair the exact range; recomputing a segment never touches the others.** Each `issues[]` entry has a
   `kind` and `range`:

   | Signal | Meaning | Action |
   |---|---|---|
   | `identity_switch_suspected` | the box stopped resembling the subject (a bystander, the cameraman) | Re-anchor from the switch onward: `ground_target` (or the analysis bbox) in range, then `libi.track({ action: "compute_segment", trackId, range, method:"yoloe+botsort", anchors })`. Never `skip_segment` a wrong-subject window: the overlay would still render on the wrong person around it. |
   | `oversized_box_while_visible`, `full_canvas_while_visible` | a bad detection balloons the box | Re-seed the range with a tight, subject-sized anchor, or skip it if untrackable there. |
   | `edge_pinned` | followed a background person at the frame edge | Re-anchor or skip that range. |
   | `low_visibility` / lost range, no `identity_switch_suspected` | the subject is genuinely absent or occluded | Look at the range first (analysis, or extract frames there). If it is truly gone: `libi.track({ action: "skip_segment", trackId, range, reason })`; the overlay honestly hides. Re-anchoring cannot conjure a subject that isn't in frame. |
   | `size_jitter`, box on the right subject | a size problem, not a position problem | Do not re-anchor. Tighten `libi.tracked_overlay({ action: "update", overlayId, maxBoxScale:1.3 })`. |
   | Bounce on the right subject | position jitter | Already damped by default; see the reference. Do not change `smoothing`. |
   | two or more similar subjects, repair keeps failing | the appearance gate cannot tell them apart | `libi.track` action `list_candidates` then `libi.track` action `pick_candidate` (reference). Not `skip_segment`, not blind re-anchoring. |

   Rule of thumb: a confident box that no longer resembles the target means switch, so re-anchor; no confident
   box at all means gone, so skip. A `compute_segment` call with `anchors` is the primary force-track move,
   not a last resort, and it writes no user-visible manual anchor.

5. **Verify, then loop until right.** Call `libi.tracked_overlay` action `verify` (pre-attach:
   `{ fileId, trackId, content, fit, scale? }`). It is read-only and picks the frames most likely to be wrong
   (issue ranges, lost ranges, the final seconds, sampled between anchors, since anchor frames are right by
   construction) and returns them as images with per-frame `segmentId`, `method`, `status`, `isAnchorFrame`.
   Look at them: right subject, head-sized not torso, not lagging, not ballooning. Fix each wrong frame's exact
   window with the table above, then verify the same window again. When the user says the track is off around
   mm:ss, call it with `focusRange:{start,end}` and re-anchor that window.

6. **Attach.** Check `libi.track({ action: "list_segments", trackId })` shows every window `ok` or `skipped`, then
   `libi.tracked_overlay({ action: "add", pieceId, trackId, startTime, duration, rect, z, opacity, content, fit, scale,
   smoothing:"linear" })`. `duration` is the clip length (`mediaDuration` from `libi.list_files`); `rect` is the
   composition rect.
   - **Pick `fit` by track kind.** Face track: `fit:"tight"`, `scale` 1.0-1.1; the box already is the head, and
     `fit:"head"` would extend it upward about 50% and inflate the emoji. If it still looks large, lower `scale`
     (0.9); never switch to `fit:"head"` or `"rect"`. Whole-person `objectKind:"object"` track: `fit:"head"`.
     Blur, pixelate, mask and object stickers: `fit:"tight"`, scale 1.0-1.2. `fit:"rect"` is only for a deliberate
     constant-pixel badge.
   - `content` is one of `{kind:"emoji",char}`, `{kind:"text",content,font,color,align}`, `{kind:"image",fileId}`,
     `{kind:"video",fileId,trim?:{start,end}}`, `{kind:"code",drawFunction}`, `{kind:"effect",op:"blur"|"pixelate"|"mask"}`. "Bigger"
     or "smaller" is `libi.tracked_overlay({ action: "update", scale })`.
   - Many overlays can share one track: call `libi.tracked_overlay` action `add` again with the same `trackId` and different
     `startTime`, `duration`, `content`, `z`. The track is sampled at absolute clip time. Different subjects get
     one track each.
   - `smoothing` is interpolation between stabilised samples, not a denoiser: keep `linear`.

Prefer an honest skip to a bad track. `visible:false` means the engine lost the subject; believe it. Long calls
stream progress and resume from their last checkpoint when repeated with the same `fileId`, `anchors` and
`fps`; `libi.job({ action: "status" })` / `libi.job({ action: "cancel" })` give manual control.

If the subject is a catalogue character or item, pass `subjectId` to `compute` so the track is
associated for reuse (`using-character-library`).

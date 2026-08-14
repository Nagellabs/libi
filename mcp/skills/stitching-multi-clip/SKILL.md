---
name: stitching-multi-clip
description: Build a multi-clip timeline from N independently-generated short video clips as SEPARATE per-beat video overlays. The editor's playback engine smooths the clip-boundary seams; concatenation into one file is a FINAL-EXPORT concern, not a way to fix preview jumps.
when_to_use: ANY time the composition will have more than one video overlay whose sources are independently generated (e.g. Path C stitch source + AI infill, Path E multi-clip stitch, manual user-driven multi-clip projects). Skip when the timeline is a single source (Path A character-swap on one continuous clip, Path D extend chain with one final file, Path B restyle of one source).
---

# Stitching Multi-Clip

When the composition has N≥2 video overlays from independently-generated source files, **keep each clip as its own layer on the timeline.** The editor's playback engine handles seam smoothness — Tier 0 preroll/double-buffer + hold-last-frame at the cut, plus a background seam render-cache (`seam_cache`) that bakes a short MP4 spanning each boundary and plays it across the seam. There is NO clip-boundary glitch to work around, so do NOT pre-concatenate the timeline into one file. Collapsing N overlays into one destroys the non-destructive per-beat editability (re-rolling a single beat, trimming one clip, swapping audio per scene). Concatenation is genuinely needed only at FINAL EXPORT.

## Before you draft the plan — load `voiceover-production` FIRST

This skill owns the stitch's CLIP plan (the partition below); **`voiceover-production` owns the
stitch's VOICE plan.** Load it **before** you draft the audio for any beat — not after you present
a plan. The default for a voiced AI beat is the main character's `reference-to-video` `@Audio1`
carry (`generate_audio: true`), NOT laying source audio under the clip as a separate track (the
mute-and-overlay anti-pattern). A beat/voice plan drafted without `voiceover-production` (and this
skill) loaded is **provisional** — re-derive the audio half here before generating anything. Do not
present a plan, then reconcile it to the skills afterward; load first, plan second.

## Partition the source — replace the surrounding, reuse the product demo (DEFAULT)

A UGC stitch is almost always a **variation/duplication** job: the user has a
source ad and wants many versions to post (a new character, the same character
with new speech, a new hook). The whole point is to **regenerate the
character-driven surrounding and reuse the physically-real product demo** — so
partition the source by **identity** and **replicability**:

- **REPLACE with new AI → the character-driven *surrounding*.** The talking-head
  hook, the on-camera presenter, the spoken script. This is what varies across
  posts. Generate it fresh — new character model · same character with new speech ·
  a new hook.
- **REUSE from source → the *product-demonstration* sections** that are **(a)**
  showing the product in use, **(b)** **identity-neutral** (hands-only /
  product-only / no recognizable face), and **(c)** physically real & replicable.
  This footage is the expensive-to-fake realism (and the AI-money saver) — keep it
  as REUSE (trim) beats. A reused clip must NOT show the original creator's face,
  or it clashes with the new character.

**Hard gate — run the partition AFTER analysis, BEFORE any generation, and get the
plan approved.** Classify every source segment as REPLACE (character-driven) or
REUSE (identity-neutral product demo), present the reuse/replace plan, and only
generate once the user approves it — so the script is right before you spend
credits.

**Hard gate — no reusable product-demo section.** If the source has **no
identity-neutral, replicable product-demo section** to cut up (e.g. it's all the
creator's face talking; the product is never shown standalone), **STOP — explain
that to the user and work out the strategy together**: a full from-scratch
recreation (no reuse), reframe/crop a partially-usable moment, or an explicit
trade-off. **Never silently force a bad partition.**

**Alternative — preserve the creator / fill the gaps.** When the user wants to
**stay on camera themselves** (keep the real creator, just fill missing beats),
invert the partition: REUSE every person-on-camera moment from the source, and
restrict AI beats to faceless inserts (product close-ups, b-roll, hands-only,
transitions) — never generate a different person to stand in for the real creator.
Offer this branch when the user signals "keep me in it"; otherwise the variation
default above is what a UGC stitch means. Load `ugc-craft` for pacing + the
product/character-consistency phrasing.

## Physical continuity across the reuse seam (HARD REQUIREMENT)

A stitch presents the reused source beats and the new AI beats as the **same person**.
So the new character must be physically consistent with whatever the reused footage
shows. **BEFORE generating the character or any AI clip, read the analysis (keyframes +
summary) of EVERY reused segment and inventory the character parts visible in it** —
faces and body parts both. Then:

- **Faces of the replaced character → those frames CANNOT be reused.** If a reused
  segment contains ANY frame showing the original creator's identifiable face (and the
  plan is to replace them), the reuse is invalid as-is. A reused "identity-neutral" beat
  that still shows the original face is a DEFECT — the viewer sees the replaced person
  reappear (the observed bug: a "product-demo" reuse leaked the original creator's face
  at BOTH ~0:13 and ~0:55). The fix is a forced, fine-grained, **applied-and-re-verified**
  boundary check on EVERY reuse segment — not a glance at the existing keyframes:
  - **The analysis keyframes are SPARSE — they do NOT cover your trim edges.** Frame
    sampling runs every ~2–3s, so the actual first/last frames of a reuse trim fall
    BETWEEN sampled keyframes, in an un-analyzed gap where the original creator's
    face/body routinely sits (a hands-only demo is almost always book-ended by the
    creator on camera). Trusting the sparse keyframes to clear a boundary is exactly how
    the leak ships — those exact edge frames were never looked at.
  - **So for EVERY reuse segment, EXTRACT FRESH boundary frames** at a FINE step
    (≤0.5s) across the first ~1.5s AND last ~1.5s of its `[start, end]`, via
    `libi.analysis_extract_frames` (or `libi.generate_thumbnails`) at those exact
    timestamps — add the extra extraction calls; never rely on the original sparse pass.
    Inspect each extracted edge frame. If the replaced character's face (or an
    identifiable body part you are NOT matching) appears, move that edge INWARD and
    **re-extract the new edge** until it is clean. If the product moment can't be kept
    without the face, drop that sub-section or regenerate it.
  - **APPLY the tightened trim, then RE-READ the committed scene — never trust the
    write's success payload.** Write the corrected `trim.start` / `trim.end` with
    `libi.update_overlay`, then **`libi.get_composition` and confirm the layer's
    committed `trim` actually equals your safe window** — a tool returning
    `{ success: true }` is NOT proof the write landed (a real dogfood bug had the
    trim update report success while the committed trim stayed the loose original).
    If the committed trim still shows the old loose values, the write did NOT
    persist — fall back to delete-and-recreate (`libi.remove_overlay` then
    `libi.add_overlay({ kind: "video", fileId, trim })` with the tight trim) and
    re-read again.
  - **RE-EXTRACT from the READ-BACK committed trim values, not your planned numbers.**
    Pull fresh frames at the scene's *actual committed* `trim.start` / `trim.end` (from
    `get_composition`) and confirm no face/body leaked. A trim you only *described*
    tightening — but never wrote, or re-extracted from your plan instead of the committed
    scene — is the exact failure that shipped the original creator's face at 0:13 and
    0:55. **"Patched" is not true until the committed trim equals your safe window AND a
    frame extracted at that committed edge is clean.** This read-back + applied-edge
    re-verify is mandatory in the Stage 8 pass below.

- **Body parts (hands, arms, legs, skin, hair) → the new AI character MUST MATCH them.**
  Extract the visible attributes from the reuse analysis — **skin tone (non-negotiable)**,
  apparent **age**, **build / height**, **gender**, and distinctive features (e.g. a
  hairy + muscular leg, freckled hands, a specific manicure, a tattoo). The new character
  — the **Stage 1 portrait AND every generated AI clip** — must match those attributes,
  because the reused footage IS that character's body in the ad's fiction. **A
  Black-creator hook over white-handed reused demo footage is a HARD FAILURE** (the
  observed bug) — the viewer sees two different people. Skin tone is the one you can
  never get wrong.
  - **If an AI clip must continue or mimic a SPECIFIC reused body part** (e.g. the same
    hand finishing an action the reused footage shows, or the same leg) → pass the
    reused frame as a **reference image** (`@Image1`) in that clip's generation so the
    body part matches, not just its description.
  - **If the match only needs to be GENERAL** (no pixel-exact continuity) → encode the
    matching attributes in the AI generation **prompt** (skin tone, age, build, gender,
    distinctive features) so the generated character is consistent.

**Surface this at INTAKE, not after.** The MOMENT you ask the user what the new creator should
look like, **LEAD with the constraint** — e.g. *"the reused demo shows light/medium-tan hands, so
the new creator should be a similar skin tone; if you want a very different look, we'd also need to
regenerate the hand beats."* If the user then names a look that **CLASHES** with the reused body
parts (e.g. a dark-skinned creator over light-skinned reused hands, or a man over a woman's hands),
do **NOT** just accept it and generate — **push back** and offer: (a) pick a matching skin tone,
(b) also regenerate the affected hand/body demo beats with matching skin (extra AI cost), or
(c) accept the visible mismatch. NEVER silently generate a clashing character. The gate runs
**BEFORE** the character is generated: the reused footage **constrains** the new character, never
the reverse.

## Clip length — favor LONG cuts (same default as the full-AI UGC skill)

A stitch is "multi-clip" because it has separate scenes — that is NOT a license to
**fragment**. Use the SAME long-cut default as `ugc-product-video`: prefer the longest
clip the model/footage allows, and reach length through fewer, longer clips — not many
tiny ones. `ugc-craft`'s **Clip-duration methodology** (load it) is the authority and
applies to the stitch's AI inserts exactly as it does to a full-AI ad.

- **AI inserts:** each insert defaults to the **longest clip Seedance allows (≤15s)** with
  its beats as **in-prompt jump cuts** — generate ONE longer insert with internal beats
  rather than several 3–4s inserts. Cut an insert shorter ONLY when the script genuinely
  needs a brief connective beat (a 2–3s product macro between two talking spans).
- **REUSE source trims:** keep them as **few and as long** as the footage supports — trim
  to the meaningful continuous spans, don't chop the real footage into many micro-trims.
- **"One scene per beat" (below) means one scene per beat you CHOSE in the partition** — pick
  as few, as long beats as tell the story; it is never an instruction to over-segment.

## When this skill applies

- **Path C** (stitch source + AI infill) — REUSE source-trim segments + REGEN i2v outputs are independently encoded.
- **Path E** (multi-clip stitch) — each beat is a separate i2v output.
- Any future multi-clip flow.

**Does NOT apply** to:
- Path A (one continuous source video, character swap returns ONE clip per call, but they replace one of the source's segments — the source's audio + most of the visuals are the unified base; one scene already)
- Path D (extend chain returns full file; one scene already)
- Path B (single restyled source = one clip)

## The flow — separate scenes per beat

> **Storyboard placement (default).** Under a storyboard flow — the default for
> `ugc-product-video` / `generic-video` / `music-video-creation` — each beat below is a
> Storyboard **card**, and the board is how the timeline is built. Place an **AI beat** as a card
> whose take is the generated clip: `libi.attach_storyboard_clip` + `libi.select_storyboard_take`,
> NOT a bare `libi.add_overlay`; a re-roll (below) becomes "attach a new take + select"
> instead of `update_overlay`. A **REUSE beat** keeps the trim + applied-edge re-verify
> mechanics below EXACTLY as written — they are the QA-critical face-leak guard, built around the
> layer's committed `trim` (`update_overlay` + `get_composition` read-back); do not re-route
> them. Either way every beat stays its OWN separate layer, never collapsed. Only on an explicit
> storyboard opt-off ("skip the storyboard / just generate") is the whole timeline built with bare
> `add_overlay` calls as shown below.

1. **Save each clip as its own asset** on the piece (multi-take variants grouped in their beat folder — see `using-asset-folders`).

2. **Build the timeline with ONE full-frame video OVERLAY per beat**, laid end to end in playback order, each pointing at that beat's `fileId`:
   ```
   libi.add_overlay({ pieceId, kind: "video", fileId: <beatA-file-id>, startTime: 0,  displayName: "<beat A>" })
   libi.add_overlay({ pieceId, kind: "video", fileId: <beatB-file-id>, startTime: <end of beat A>, displayName: "<beat B>" })
   ...
   ```
   Omit `rect` for a full-frame `fit:"cover"` layer; omit `duration` to auto-detect it from the file. Set each beat's `startTime` to the cumulative end of the ones before it so they play back-to-back, and give them the SAME `z` band (they never overlap in time). No `trim` unless the beat needs it.

3. **Audio policy — ALWAYS ASK first: reuse the source voice or make a new one? Then default to
   Seedance `@Audio1` sync (never ElevenLabs by default).** Load `voiceover-production` (REQUIRED
   — it is the voice authority and owns the full decision tree); this step is the **stitch
   always-ask gate** it points to.

   A stitch mixes reused source beats with new AI beats; the goal is ONE consistent voice across
   the whole piece WITHOUT a clone. **Before you draft the voice plan, ASK the user:** *"Reuse the
   voice from your source, or give the new creator a fresh voice?"* — and **explain what they
   can't see**: if a beat you plan to REUSE already carries the source creator's voiceover, that
   voice is the cheapest, most consistent spine for the whole piece. They should understand what
   will be generated before it is.
   - **Reuse the source voice — the DEFAULT when a reused beat carries the actor's voiceover.**
     That source voice becomes the MAIN voice: **KEEP the original voiceover on the reused scenes
     (do NOT mute them)**, cut ONE clean **≤15s** sample of it
     (`libi.extract_audio({ fileId, format: "mp3", startSeconds, endSeconds })`, never
     `format:"copy"` → AAC is REJECTED, HTTP 422), and generate every new AI talking-head beat on
     `bytedance/seedance-2.0/reference-to-video` with that sample as `@Audio1` (+ the beat's start
     frame as `@Image1`, `generate_audio:true`). The new beats then speak in the source voice →
     one voice across the whole video, **no silent gaps, no ElevenLabs**. A new on-camera creator
     is a *visual* swap; the voice stays the source's, and the bookend lines should bridge the
     kept middle VO.
   - **Fresh voice — when the reused beats have NO dialogue, or the user wants a new voice.**
     Establish it from the FIRST new AI clip's native audio (`generate_audio:true`) → sample it →
     `@Audio1` on every other AI beat for continuity; mute (or leave ambient) the dialogue-free
     reused scenes under that voice.
   - Always **generate voice on AI clips** (`generate_audio:true`) — a clip can be muted +
     replaced later, but a silent generation is a defect.
   - **Match the source's speaking DELIVERY in the AI clip prompt.** The `@Audio1` carry
     reproduces the source's voice *timbre*, but the new beats speak NEW lines — their
     pace, energy, and cadence come from the **generation prompt**, not the reference.
     Read the source speaker's delivery from the analysis/transcript — **talking speed
     (e.g. fast/clipped vs slow/measured), tone, energy, accent/cadence** — and put it in
     every AI talking-head clip's prompt (e.g. *"speaking quickly and energetically,
     casual fast-paced UGC delivery, upbeat"*). A new creator who talks at a visibly
     different speed or energy than the kept source-VO middle breaks the single-person
     illusion as much as a skin-tone mismatch — the bookend AI beats and the reused VO
     must sound like the SAME person talking.
   - **Write the bookend lines to DOVETAIL with the reused middle's ACTUAL transcript — and trim
     the reuse on CLEAN CLAUSE BOUNDARIES.** The kept middle already carries real spoken words; the
     new AI bookends must read as one continuous monologue with it, not collide or repeat. Before
     writing the lines, pull the reuse window's transcript (the exact first words it opens on and
     the exact last words it closes on). Then: (a) the **hook line HANDS OFF into** the reuse's
     opening — it must NOT end on the same sentence the reuse begins with (the observed bug: the
     hook's last line WAS the reuse's first line, so the viewer heard it twice). (b) Choose the
     reuse trim's **start and end at natural sentence/clause boundaries** in the VO — never cut
     mid-sentence (the observed bug: the reuse ended mid-word on "day one" and hard-cut to the
     "day two" verdict). (c) the **verdict line PICKS UP from** the reuse's closing words and
     explicitly bridges any time/topic jump ("…okay, two weeks later —"). The seam-trim choice is
     therefore TWO constraints at once: a face-free edge (Physical continuity) AND a clean
     spoken-clause edge.
   - Put the local sample + each start frame on the fal CDN via **`libi.upload_file_to_fal({ fileId })`**
     first — **NEVER** read `FAL_KEY` from the DB/env/shell or `PUT`/`curl` to fal storage yourself.
     Reuse the SAME `@Audio1` on every AI beat; persist it as a per-character voice asset
     (`using-character-library`) for the other variations.

   **A voice-CHANGE — a voice that is neither the source's nor the native AI voice (a
   specific/branded read or a clone) — is a separate, user-triggered step: the
   `voice-replacement` skill.** Never the default, never an auto-substitute for the
   `@Audio1` sync above. The generation-time voice tree (native + carry) lives in
   `voiceover-production`; re-voicing the finished stitch lives in `voice-replacement`.

4. **Stage 8 verify** by the calling skill: expects one scene per beat (scene count + order match the beat plan), each pointing at its own clip — NOT a single collapsed scene. **This pass MUST include the applied-edge re-verify** from "Physical continuity" above: re-extract the FIRST and LAST frames actually in each reuse scene's committed trim and confirm no replaced-character face/body leaked at the seam. A seam re-verify done on the sparse keyframes (instead of fresh edge extractions) or done on the *planned* trim (instead of the *written* one) does not count — that is the gap that shipped the 0:13 / 0:55 leaks.

5. **Director's continuity review — the FINAL gate before commit (REQUIRED).** The Stage 8 checks
   above are *technical* (right scenes, no face leak, one voice). They do NOT prove the finished
   video makes sense as a video. So after the build is technically clean, **run a fresh-eyes
   editorial pass — review it as a VIEWER, not the builder.** See "Narrative continuity" below.

## Narrative continuity — the director's review (HARD, final pass)

A technically-correct stitch can still be a bad video: the speech can repeat, cut off mid-sentence,
or jump in time/topic at a seam so the cut feels fake. The technical gates can ALL pass while the
*story* breaks. So before commit, do a **director's review** — step out of build-mode and judge the
assembled piece the way a viewer would.

**Run it with fresh eyes — ideally dispatch a SUBAGENT.** The agent that built the piece is anchored
to its own plan and will rate its own seams generously. Spin up a separate reviewer (a subagent, or
a deliberate clean-slate pass) and hand it ONLY: the **full spoken script in timeline order** (hook
line → the reuse window's actual transcript → verdict line), the **ordered scene list with
durations**, and **a frame from each side of every seam**. Ask it one question: *"Watching this
straight through, does it read as ONE genuine, continuous UGC video — or does anything feel off?"*

It must specifically catch:
- **Repeated line at a seam** — the AI bookend says the same sentence the reused VO then repeats
  (the observed bug at the hook→reuse seam).
- **Cut-off / mid-sentence seam** — the reuse ends (or starts) mid-thought, or the next clip starts
  talking before the previous thought finished (the observed bug at the reuse→verdict seam).
- **Unmotivated time / topic jump** — "day one" hard-cutting to "day two" with no verbal bridge;
  a claim in a bookend that the reused middle contradicts; an emotional/energy whiplash.
- **Pacing** — a seam that switches what the scene is "about" too fast to follow.

**If it finds a break, ADAPT — don't ship it.** Fix with the cheapest tool that works: re-time the
reuse trim to a clean clause boundary (free), re-write a bookend line to bridge in/out of the kept
VO and re-roll only that one clip, or insert a short connective beat. Then re-run the review. Only
commit once it reads as one continuous, genuine video. A stitch that is technically perfect but
narratively choppy is NOT done.

## Re-roll path (per beat)

A bad beat is fixed in place — no concat to rebuild:
1. Identify the bad beat's scene.
2. Re-generate that ONE clip with a corrected prompt (save it as a new asset in that beat's folder).
3. Point that layer at the regenerated clip via `libi.update_overlay`.

The other scenes are untouched.

## Final export (the ONLY place concat belongs)

At export time the composition genuinely concatenates — that is handled by the export pipeline (a multi-scene comp routes through the canvas-source backend; a contiguous trim-only single-video comp can stream-copy). The agent does not pre-concatenate the timeline to make export work. If a user explicitly wants a single flattened source file as a deliverable asset (not the timeline), `libi.concat_videos` with the ordered `fileIds` produces it (stream-copy when codecs match, re-encode otherwise) — but that output is a separate asset, NOT a replacement for the per-beat timeline.

## Cost

- `libi.concat_videos` `-c copy` fast path: $0 (CPU-only ffmpeg, sub-second).
- Re-encode fallback: $0 (CPU-only ffmpeg, ~0.5 s per second of input at 720p).
- No fal-ai calls.

## Logger tag

`stitching-multi-clip` (when the agent calls `libi.concat_videos`, the underlying ffmpeg op is tagged `concat_videos_copy` or `concat_videos_encode` per the existing `runFfmpeg` op table).

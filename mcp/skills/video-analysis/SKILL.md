---
name: video-analysis
description: Analyze a video's visual content. Default to the free agent-driven flow (extract keyframes, describe each, produce VideoSummary) — this covers most tasks. Only mention the paid Gemini-via-fal.ai script flow when the task genuinely needs audio/music understanding or the user explicitly asks for it.
when_to_use: User asks to summarize, analyze, or search visual content of a video. For audio-only files, use audio-analysis instead.
---

# Video Analysis (Frames + Summary)

Use this skill when the user wants visual analysis of a video — keyframe extraction, per-frame description, and/or a structured summary. For the transcript step, see the `audio-analysis` skill — it handles long files via chunking automatically.

## Pick a flow before running anything

Two flows produce analysis for a video. Default to (A); only branch to (B) when the user's intent fits.

**(A) Agent-driven flow (default, FREE).** You — the agent — extract keyframes, run your own vision on each, and write structured `FrameDescription` / `VideoSummary` via `libi.analysis_save_*`. Strengths: free, gives per-frame bboxes (needed for tracking and character catalog), gives you control over what to look for. Weaknesses: per-frame independent (weak cross-shot continuity), can't hear audio (no structured music/SFX), slow on long videos.

**(B) Model-driven script flow (PAID, opt-in).** Run `libi.extra_analysis_model`. A single fal.ai → Gemini 2.5 Pro call returns a structured `Script` (shot list with camera/lighting/mood/dialogue per shot, structured music & sound-design, overall style, pacing). Strengths: hears audio, sees the whole video at once (real shot boundaries, real music cues), one fast call. Weaknesses: paid (fal credits), no per-frame bboxes, no word-level transcript timing.

> **`focus` parameter on (B).** `libi.extra_analysis_model` accepts `focus: "script" | "captions"` (default `"script"`). `focus: "captions"` runs a caption-focused prompt instead — it returns a per-caption recreation spec (each caption's words, anchor world-vs-screen, motion keyframes with center + height-fraction, reveal schedule, orientation, color/glow) as text in `data.captions`, stored under a separate `caption_spec:*` step (NOT a `Script`, never shown in the Script tab). This is the analysis the **`mimic-video-captions`** skill drives when reproducing on-screen captions — it watches the whole video, so it describes how captions *animate*, which the free per-frame pass (A) cannot. Same cost basis (~$0.002/s). Don't surface `focus: "captions"` for ordinary analysis — it's for the caption-mimic flow.

### When to suggest (B)

**Default behavior: just run (A) without asking.** (A) is free and covers nearly all real tasks — search, captioning, character extraction, summary, even most recreation work. Do NOT mention (B) for ordinary asks. The user doesn't need to know it exists for routine work.

Only consider surfacing (B) when ONE of these is true:

1. **The user explicitly asks for it** — they say "use Gemini", "do the paid analysis", "full audio analysis", "I want a script for re-creation", or similar.
2. **The task genuinely needs what only (B) provides** — i.e. structured music/SFX understanding or full-video continuity that per-frame (A) can't deliver. Concrete triggers:
   - Music video work where matching the song's beats, mood, or instruments is the point
   - Re-creating a video where audio dynamics (laughter, applause, ambient cues) drive the cut
   - Long videos (>5 min) where dense per-frame description would be slow AND the user wants a holistic script
   - The user describes the source as "audio-heavy" or specifically mentions music/sound design as important

If neither applies — run (A) silently. **Recreation ≠ "needs (B)"** for the *analysis* choice
(A is enough). But note: if the user wants to **recreate / remake / mimic** the source video
(not just understand it), that is NOT your job here — you are the analysis engine. Return control
to the `mimic-video` dispatcher (which calls this skill for the analysis step, then routes the
recreation to the right creation skill). Do NOT generate clips directly from this analysis.

### Before offering (B), check the key

If you ARE going to surface (B), first verify the user can actually use it:

1. Call `libi.list_bundled_mcps` and find the `fal-ai` entry.
2. If `installStatus !== "ready"` OR the fal-ai row shows the FAL_KEY env var is unset/empty, the paid path is NOT available.

When (B) is unavailable:

- **If the user explicitly asked for it:** tell them the key is missing and navigate them to the fal-ai MCP settings (`libi.show_mcp_settings`). Ask whether they want to set the key now (then re-run), or whether the free flow is acceptable.
- **If (B) would have been useful but the user didn't ask:** stay silent about it and just run (A). Don't make the user feel like they're missing something they didn't ask for.

When (B) is available AND warranted, surface it with a short message and let them choose:

> "I can analyze this video two ways:
> - **Free** — I'll watch each keyframe and write up what I see. No audio detection, no music description. Good for editing tasks.
> - **Paid (~fal credits)** — Gemini-via-fal.ai returns a full production script with shots, music, dialogue, and mood — designed to feed back into a text-to-video model. Best when audio/music drives the structure.
> Which do you want?"

### After running (B), decide if (A) is also needed

The `Script` from (B) doesn't include per-frame bboxes or word-timed transcript. If the user's downstream task needs those, run (A) on top — they're additive (script rows and frames/transcript rows coexist on the same `analysis_steps` table). Heuristic:

| Downstream task | Need (A) on top of (B)? |
|---|---|
| Feed shots to a text-to-video model | No — `Script` is sufficient |
| Build tracked overlays (blur a face, pin a label) | Yes — need `bbox` on `people[]` / `objects[]` |
| Build word-level caption overlays | Yes — need `audio-analysis` skill (ElevenLabs transcript) |
| Add subjects to the character/item catalog | Yes — need `people[].name` + `bbox` on frames |
| User just wants to read what's in the video | No — show them the script |

When unsure, ask: "I have the script. Do you also want me to extract per-frame bboxes (for tracking/character cataloging) or a word-timed transcript (for captions)?" If they say yes, continue with the existing (A) flow on the same `fileId`.

## Frames flow

1. **Extract keyframes** with `libi.analysis_extract_frames`. The tool's schema gives the exact
   args; the part that's YOUR judgment is **how many** — density matters, and a flat 8 is NOT
   enough when the subject will be tracked:
   - video **< 5 min** → one frame every **~3 s** → `count ≈ ceil(durationSec / 3)`
   - video **≥ 5 min** → one frame every **~10 s** → `count ≈ ceil(durationSec / 10)`

   (e.g. a 38 s clip → ~13 frames; a 4 min clip → ~80; a 12 min clip → ~72.) Evenly spaced; for
   specific extra moments request explicit timestamps instead of a count. This dense pass is what
   makes subject anchors dense enough to hold identity through duets/crowds — describe the
   subject's name + bbox on every frame they appear in. The tool returns frame paths + indices
   and does NOT write to the DB yet.

   **Use `libi.analysis_extract_frames` for ALL frame inspection — never
   `libi.generate_thumbnails`.** `analysis_extract_frames` returns frame paths you
   read directly (for your vision) and keeps the stills as analysis artifacts in
   the **Frames tab**, auto-managed and out of the way. `generate_thumbnails`
   instead writes throwaway JPGs into the **piece's assets**, cluttering the asset
   grid with dozens of `-thumb-NN.jpg` files the user then sees as piece content —
   even a "just let me glance at the captions" peek must go through
   `analysis_extract_frames`, not a thumbnail dump you later have to delete.

2. **Describe each frame** using your own vision. For each, build a `frame_v1` `FrameDescription`
   — the tool's input schema defines the exact fields; the ones that carry weight are `scene`
   (one-sentence description), `people[].name` for identifiable subjects, `objects[].name`,
   `tags`, `text_on_screen`, and `shot` (close-up / medium / wide / extreme-wide).

   **Tracking bboxes (important judgment call):** for any named person or object the user might
   want to track later, include its `bbox`. The schema documents the exact format (normalized
   0..1, relative to the source frame); the judgment the schema can't give you is that you must
   **estimate from the full source frame, not the thumbnail you see**, and that **omitting bbox
   leaves the tracker with no anchor** on that frame (large gaps). Add it for trackable people AND
   for trackable products / logos / props.

   **On-screen text — record the TREATMENT, not just the words.** When a frame has captions /
   lyrics / kinetic typography (especially if the video may be recreated), note in `text_on_screen`
   (or a `custom` note) not only the wording but the *look*: colour, glow, weight, position — and
   crucially **whether the text is FLAT (screen-space) or placed IN the scene's PERSPECTIVE**.
   Flat = level baseline, constant size, parallel to the screen. Perspective = mapped onto a
   road/floor, anchored at the **vanishing point**, baseline **tilting/curving with the surface**,
   **growing as the camera moves toward it**. This flat-vs-perspective tell is the cue that later
   decides a flat 2D caption recreation (`animated-text-overlays`) versus a 3D one
   (`three-overlays`) — a 2D zoom/scale punch is NOT perspective, so don't mistake one for the
   other.

   **One frame can't show the ANIMATION — and the animation is often the design.** A single
   still freezes a caption that may actually be dollying toward the camera or rushing up from
   the vanishing point; frozen, it just looks like flat text. So when a caption's treatment
   matters (recreation), extract **multiple frames ACROSS a single caption's on-screen window**
   (3–4 over its ~1s life), not one, and compare them: if the text **grows / recedes / moves
   through the scene** between consecutive frames, it is ANIMATED (and usually 3D/in-scene).
   Record the *motion* (static · grows-toward-camera · slides · recedes), not just the static
   look — downstream caption recreation needs the motion to choose flat-2D vs 3D, and the
   per-frame still alone will quietly under-call it as flat. **But do NOT yourself rule
   "flat 2D" vs "3D" for a caption you'll recreate** — a centered scale-punch and a 3D
   dolly-toward-camera are indistinguishable in a still, so "it's just a 2D scale punch" is
   not a call you can make here. Just describe what you observe (the text zooms in / grows /
   sits at the vanishing point) and leave the 2D-vs-3D decision to the recreation step, which
   asks the user.

3. **Save in batches** with `libi.analysis_save_frames` (upsert by frame index). For long videos,
   save 10–20 frames per call; later calls add or update frames. Saving does NOT delete prior
   frames — if you want a clean reset before re-extracting at a different density, clear the
   frames step first with `libi.analysis_remove_step`. For unusable frames (black, extreme blur),
   mark the entry skipped with a reason instead of describing it.

## Summary flow

After describing frames (and ideally after the transcript step, but that's optional):

1. Read existing analysis with `libi.analysis_get`.
2. Compose a `video_v1` `VideoSummary` aggregating subjects, sections, recurring objects, audio
   summary, and visual style.
3. Save it with `libi.analysis_save_summary` (pass the summary as a structured object).

The tool's schema defines the required fields (`overview`, `duration`, and the `subjects` /
`sections` / `recurring_objects` arrays). Empty arrays are fine when unknown.

## On failure

If you can't describe frames (vision unavailable, model refuses, etc.), mark the step failed with
`libi.analysis_mark_step_failed` (kind `frames`, with a message). Same for the summary. The user
sees the message in the analysis tab and can ask you to retry.

## Search

After frames are saved with structured descriptions:

- `libi.analysis_search_frames` — filter ready frames by subject, objects, on-screen text, tags,
  time range, or shot type.
- `libi.analysis_search_transcript` — substring match against transcript words.

Use these to answer follow-up questions like "find every frame where X appears" or "where does
the speaker mention Y".

## When NOT to use this skill

- The user only asks for a transcript: use `audio-analysis` directly.
- The user uploaded an audio-only file: only `audio-analysis` applies; visual fields don't exist.
- The user asks about the catalog directly (browsing, renaming, deleting, linking an existing character/item): that's `using-character-library`'s job, not this skill's — hand off to it.
- The user wants to **recreate / mimic / remake** the video (not just analyze it): start from the
  `mimic-video` dispatcher — it calls this skill for the analysis step, then routes to a creation
  skill.

## Cross-reference

After saving the video summary (and the frame descriptions it's built from), review the recurring named subjects you set — `people[].name` in frame descriptions, `subjects[].name` in the summary. For each subject who is a clearly-recurring CENTRAL figure or object in the video (the presenter, the product being shown, a named character who reappears), follow the `using-character-library` skill's auto-catalog workflow: check the catalog, create if missing, and report inline with the representative image — don't just note the name and move on. Skip one-off extras, generic unbranded objects, and incidental strangers; those never get cataloged. The two skills compose: this one analyzes the video, that one persists and surfaces recurring identities.

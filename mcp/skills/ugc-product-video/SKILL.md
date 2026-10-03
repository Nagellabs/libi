---
name: ugc-product-video
description: "Make a UGC-style product video or ad: 'make a UGC video', 'create a product ad', 'TikTok-style video', 'demo video for my product', any request to film a person showing or using a product. Defaults to one full-length multi-beat clip. Not for other genres (generic-video) or music videos (music-video-creation)."
tags:
  - ugc
  - generation
---

# UGC Product Video

Needs a **video** provider: one in your tool list, or a libi extension (those count). Read the `references/providers/<id>.md` here for the provider you use before your first call. With none, call `libi.suggest_provider({ kind: "video" })` and stop; the full rule is `libi.read_manual({ section: "providers" })`.

Done looks like: a UGC-style ad the user approved at the script, built through the storyboard, every AI clip validated, voiced, captioned and verified against the plan before commit. This skill owns that shape and the gates; `prompts/` holds the craft and is read as the flow reaches it. Generate through `ai-asset-generation`, never with provider tools directly.

## The default shape: one full-length clip

Generate the ad as **one multi-beat clip at the chosen model's own per-clip max** (verify it in the schema; the default model allows 15 s). Hook, Show, Demo and Verdict are jump cuts the model renders inside one prompt, not separate generations: a clip per beat is what makes pacing fast and incoherent, and the worry that short clips avoid drift applies to one continuous long take, not to cuts inside a prompt.

Use more than one clip only when the script exceeds the model's single-clip max, has 36 or more spoken words, or a manipulation beat keeps failing and falls back to the editorial split (`video-generation-craft`). Then use the fewest clips, about the target divided by the model's max, each still multi-beat: a 30 s ad is two 15 s clips, not eight short ones. A recreation packs the source's shots into the fewest clips and never maps one source shot to one clip.

## Built through the storyboard

Build the ad through `using-storyboard`, for every ad, even a one-clip one. A card is one generated clip and a beat is a cut inside a card: a multi-beat ad is ONE card, an extend chain is ONE card (its versions are the takes), a stitch is N cards (a reused beat's take is the trimmed source) linked with `libi.set_storyboard_reference`. Author each card's schematic and generation spec, get the schematic approved (the free gate before spending), generate, validate, then `libi.storyboard_take` action `select`. Skip the storyboard only if the user says to, and place clips with `libi.add_overlay({ kind: "video" })`; the gates hold either way.

## The flow

1. **Frame it.** [brief-intake](prompts/brief-intake.md); a format ([ad-formats](prompts/ad-formats.md)); a route if a source video exists ([production-routes](prompts/production-routes.md)); aspect and safe zones ([platform-specs](prompts/platform-specs.md)). Load `video-planning` to break the ad into blocks: that plan is the beat sheet. Record format, route, model and opt-ins on the piece (summary in the description, durable plan in the storyboard overview).
2. **Source analysis** (mimicking a source only): the `video-analysis` skill, read for what to reproduce. A stitch loads `stitching-multi-clip` before the script; it owns the partition, the voice question and the continuity check.
3. **Character.** Ask who is in the video, make one to three candidate portraits with the realistic-images reference of `video-generation-craft`, and get the pick approved: it is the keyframe of every card. For a stitch it is constrained by the reused footage (skin tone, age, build).
4. **Product.** The user uploads references (`libi.upload_file`); look at each and write a structured summary (name, category, colour and finish, features, packaging); if they only described it, generate references first. Confirm the summary.
5. **Script.** A good ad first, then feasibility: the format's beats, [script-craft](prompts/script-craft.md), two or three [angles](prompts/copywriting-angles.md). The dialogue gate applies. The user approves the beats before any generation.
6. **Generate** each clip from the format's formula ([model-seedance-2-formulas](prompts/model-seedance-2-formulas.md)), the engine's rules in `video-generation-craft` and the craft in [craft](references/craft.md). No readable text in any prompt (`ai-asset-generation` owns the rule). Manipulation beats follow the physical-action reference of `video-generation-craft` and are isolated from any extend chain.
7. **Validate** every clip, then place it (gate below).
8. **Audio.** Native audio stays on in every route. One voice across clips and the stitch voice question: the voice reference of `video-generation-craft`. A different voice on the finished video is `voice-replacement`.
9. **Captions and end card.** Text overlays (`libi.add_overlay({ kind: "text" })`) for captions, lower-thirds and CTA, an image overlay for the end card; a product-name lower-third on the first reveal beat, a 2 s end-card holder if none exists. Text is single-line and does not wrap, so size each caption to the canvas width (`maxChars` about 0.84 × width / (0.6 × fontPx); `speech-captions` has the readability rules).
10. **Verify**, then commit (gate below). Add a short lessons note to the storyboard overview: which model and prompt patterns worked, what to avoid.

## The gates

Each is stated once, here.

- **Cost.** Before any spend, disclose the total estimated cost from the provider's pricing tool and wait for a yes.
- **Dialogue.** Before any clip that speaks, show the exact words, the word count and whether they fit the duration, and get an explicit yes: [dialogue-gate](prompts/dialogue-gate.md). It is separate from cost approval and re-runs when the words change. Whether there is a spoken line at all was settled once at the voice-line intake in `ai-asset-generation`.
- **Validation.** Every AI clip needs a real analysis record before it counts: run it through the `video-analysis` skill (look at the actual frames, persist the record) and grade it. Extra or missing fingers, fake text or readable gibberish: `reject`. Broken physics, motion jumps, character drift against the reference: `minor` or `reject` by severity. Blur or palette drift only: `minor`. Otherwise `ok`. Record the grade in the analysis and in the file's notes (`validation=<ok|minor|reject>` on the lineage line). `ok`: place the clip now. `minor`: tell the user, ask keep or regenerate (default keep), and place it the moment it is kept. `reject`: say why, regenerate with a prompt patch aimed at the failure, attach the retry as a new take on the same card, and count it against the approved spend. Place every kept clip immediately after it validates, so the timeline builds up in front of the user; a piece with generated clips but an empty timeline is a defect. For a manipulation beat, also run the paid video-understanding questions in `video-generation-craft`'s physical-action reference; that pass belongs in the beat's cost disclosure. A reused source beat skips validation, and an extend chain validates only its final output. `libi.snapshot` action `commit` refuses (`unvalidated_generated_clips`) any draft with an AI clip that has no completed analysis.
- **Verify before commit.** Read the composition back in the same turn and check it against the route you ran: the audio shape matches the route (a clip placed from a file with sound gets an inline audio clip, so a muted layer means removing that clip, and no clip may carry two voices); the clip count and order match the beat plan, kept as separate overlays and never concatenated (joining is an export concern: `stitching-multi-clip`); every planned text overlay exists and none overflows. For a stitch, re-extract fresh frames at each reused clip's committed trim edges and run `stitching-multi-clip`'s director review. On a mismatch do not commit: tell the user the gap and the fix and let them say "commit anyway". On a match, show the timeline (length, clip count, audio shape, cost) and commit.

The commit gate checks only clip validation; the audio, clip-count and text checks are yours.

## Model and overrides

`RECOMMENDED_VIDEO_MODEL = provider-default`

`provider-default` resolves through your provider reference: read `references/providers/<id>.md` and use the endpoint it marks RECOMMENDED. Suggest it with a one-line reason, and honour a per-project override ("use a different model this time") without re-pitching it. Always verify the chosen model at runtime with the provider's schema and pricing tools before generating; a written-down id is a hint, and availability and inputs drift.

When the user states a standing preference ("always use X", "make Y my default"), offer to make it permanent rather than just complying once: fork this skill with `libi.skill` action `fork` and rewrite the `RECOMMENDED_VIDEO_MODEL` line of the user copy's `SKILL.md` with `libi.skill` action `update` (pass the whole edited body), using the literal endpoint id they want. That is the only write path that reaches a forked skill and re-syncs the workspace. Never hand-edit anything under `references/`: no `libi.*` tool writes there and a raw edit triggers no sync. Reverting is deleting the user copy.

## Files, lineage, drafts

Each generated file is its own asset; group the takes of one beat in a folder named after it. Provenance (`aiGeneration`) and the notes lineage line follow `ai-asset-generation`; add the validation grade to the line once graded. Before starting, call `libi.get_piece_state`; if `hasDraft` holds unrelated work, ask whether to commit, discard or fold it in first, and offer a snapshot after each major phase (character saved, clips placed, overlays added).

Related: `using-character-library` (check it for the creator or product before generating fresh, and promote recurring ones), `using-object-tracking` (follow, blur or label a moving subject), `video-planning`, `using-storyboard`, `stitching-multi-clip`, `video-generation-craft`.

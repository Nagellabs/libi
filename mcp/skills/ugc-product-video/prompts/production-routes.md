# Production routes: where the footage comes from

`SKILL.md` owns the default shape of the ad (one full-length multi-beat clip) and the gates. This file is the footage axis: given what the user has, how the clips get made. Describe a route to the user in plain words, and when their intent is already clear (for example "generate it fresh, don't reuse my clips") record it and state the plan instead of showing a menu. Which endpoint serves each route on your provider is in `../references/providers/<id>.md`; the route is the editorial decision, the endpoint a provider detail.

Under the storyboard, every clip below is a card's take. Where a route says to place a clip on the timeline, attach it to its card and select the take (`libi.storyboard_take` action `attach_clip`, `libi.storyboard_take` action `select`); only on an explicit opt-out of the storyboard do you place with `libi.add_overlay({ kind: "video" })` directly.

## Choosing

| The user has | Route |
| --- | --- |
| No source video | **Fresh, fully AI.** The default shape from `SKILL.md`. |
| A source video and wants a new person in it, keeping the original footage | **Swap the presenter** |
| A source video and wants a new look with the same motion | **Restyle** |
| A source video and wants variations to post (new character, hook or script) reusing the real product demo, or "keep me on camera, just fill the gaps" | **Stitch real footage with AI** |
| A source video used only as inspiration | **Fresh, fully AI**, with the source's script as a beat-sheet template |

**Check for a manipulation beat before committing to a route.** If the ad's hero action is a fine manipulation of a small product (applying a nail wrap, inserting a lens, peeling a patch, sticking on a lash), plan to isolate that beat from the start as its own first/last-frame clip (`video-generation-craft`, physical-action reference); an extend chain or one long take is exactly what makes the object wiggle, shrink or vanish. Do not wait for the user to say it looks fake.

Every route: no readable text in any prompt (add text as overlays afterwards), native audio on unless the route says otherwise, and every AI clip passes the validation gate in `SKILL.md`.

## Source analysis (the three routes that use a source)

Analyze the source with the `video-analysis` skill and read its output for what you must reproduce: beat structure and timing, the spoken hook and pacing, the presenter's look and energy, the product moments, the shot grammar. The paid full-video script pass adds per-shot camera, lighting, mood and audio descriptors; it is worth offering (with its cost) for the stitch route, where threading those descriptors into each AI prompt tightens the match. Record the resulting beat plan in the piece description or storyboard overview so a later session can resume.

## Fresh, fully AI

The one multi-beat clip, built from the chosen format's formula, character reference and product reference. Longer than the model's single-clip max, or a continuous action the user wants as one shot:

- **Engine with a native extend:** generate a first clip, then extend it. The extend call returns the whole chain each time, so each return is the new complete clip and is never sliced. The whole chain is ONE card whose takes are the extend versions; the latest is the selected take and a rollback is selecting an earlier one. Group the chain's files in one asset folder and put `parent=<previous file id>` in each notes line. Validate only the final extend; to roll back, point the overlay at the last good take and re-extend from there (after re-pointing, an overlay that relies on its source audio needs its inline audio clip removed and re-created from the new file).
- **Engine without extend:** separate clips from the same character image, chained by their last frames (`video-generation-craft`, physical-action reference, section 5), each carrying continuity language ("same lighting as the previous clip, same outfit, same hair, no scene change"). Seams may show and 30 to 50 percent of clips may need a retake, so budget for 1.4 to 2 times the generation cost and re-confirm with the user if that passes their approved cap.
  If the user's model lacks extend and they want one continuous shot, offer to switch to an extend-capable model or take the multi-clip route, and say which costs more.

Audio: keep native audio on every clip. One voice across clips: `video-generation-craft`, voice reference.

## Swap the presenter

For every segment where the presenter is visible: trim it (`libi.trim_video`), put the trimmed segment on the provider's storage with its upload tool, call the swap endpoint with the new character's portrait as the reference image, and save the result with `libi.upload_file`, passing `aiGeneration`. Segments without the presenter (b-roll, hands, product close-ups, end card) are reused as trimmed source and need no provider call. Audio: keep the source audio on every clip; nothing to do.

## Restyle

Trim each segment, upload it, call the restyle endpoint (the provider reference lists a cheap default and a strength-controllable alternative) with the user's style prompt, save with `aiGeneration`. The whole timeline is the restyled source. Audio: some restyle endpoints drop the audio track; if so, add the source file's audio as a standalone clip over the restyled picture (`libi.audio_add_clip`).

## Stitch real footage with AI

Surface this before any generation call and wait for a yes: some clips will be the user's original footage and others AI, and the seams can look obvious if the AI clips do not match the source's lighting, grade, framing and camera shake; to minimise that you will run a paid script analysis on the source and feed its style summary into every AI prompt; offer fully AI or a presenter swap if they would rather avoid seams.

Load `stitching-multi-clip` before drafting the plan: it owns the partition (replace the character-driven surrounding, reuse the identity-neutral product demo), the stop when nothing is reusable, the voice question and the physical-continuity check. Then:

1. Run the paid script analysis (after cost approval) so every AI prompt can carry the per-shot style descriptors.
2. Reused beats: `libi.trim_video` the source. No provider call.
3. A talking beat with a new on-camera character: the reference-conditioned endpoint with the character's start frame as `@Image1`, the main speaker's voice sample as `@Audio1`, `generate_audio: true` and the spoken line in the prompt. A faceless product or b-roll beat: image-to-video from the product or scene reference with an action-only prompt plus that shot's style descriptor, and no identity descriptors in the text (they go in the image input, which also avoids identity filters).
4. Save each with `aiGeneration` and the notes line; validate every AI beat.
5. One full-frame video overlay per beat, in order by start time, never pre-concatenated; the editor smooths the seams and separate overlays keep each beat editable (`stitching-multi-clip`).

Audio is `stitching-multi-clip`'s voice question (reuse the source voice or a fresh one, carried by `@Audio1`; the voice reference in `video-generation-craft` has the mechanics). The only hard invariant is never two different voices on one clip: a reused clip keeps its own audio only when that voice is the chosen spine, otherwise its inline audio clip is removed (`libi.audio_clip` action `remove`) when the clip is placed. Prove it in the verify gate.

## Music

No music unless the user asks. Free on-device generation is the default; a paid music provider only on request. Add the result with `libi.audio_add_clip`, `kind: "standalone"`; `libi.audio_duck({ action: "enable" })` lowers it under speech.

---
name: video-analysis
description: "Analyze a video's visuals: summarize it, describe what happens, or search its content ('what's in this video', 'summarize this clip'). Keyframe-based and free by default; audio or music understanding is a paid extra the user must ask for. For spoken words use audio-analysis."
---

# Video Analysis (Frames + Summary)

Done looks like: the video's keyframes described and saved, a structured summary saved, and, for anyone worth tracking or cataloging later, a bounding box on every frame they appear in.

Spoken words are `audio-analysis`; run it for the transcript (it chunks long files itself). Recreating or remaking the video is not this skill's job: this is the analysis engine, and `mimic-video` calls it, then routes to a creation skill. Do not generate clips from the analysis.

## Two flows

**(A) Agent-driven, the default and free.** You extract keyframes, look at them yourself, and save structured descriptions with `libi.analysis_save`. It needs no provider: run it whether or not one is connected, and never stop for the lack of one. It gives per-frame boxes (needed for tracking and the character catalog) and control over what to look for; it is weak on continuity across shots, cannot hear audio, and is slow on long videos. It covers nearly every task, including most recreation work, so just run it without mentioning (B).

**(B) Full-video script, paid, on the user's own video provider.** One model call sees the whole video and hears it: real shot boundaries, music and sound design, a production script. libi does not run it; you run it on the provider and save the result into the analysis store. `references/providers/<id>.md` (here, for your provider) has the model, the call and the save shapes. Offer (B) only when the user asks for it, or when the task turns on what only it provides (matching a song's beats and mood, audio dynamics driving the cut, a holistic script of a long video, the user calling the source audio-heavy, or a creation skill's motion check on a generated manipulation beat, since a still frame cannot show whether the action happened). Say it is the user's provider credits, disclose the cost, and get a yes before the call. If it would help but they did not ask, stay silent and run (A). With no video-understanding provider connected and the user asking for it, say so, call `libi.suggest_provider({ kind: "video", reason: "paid full-video analysis" })`, and let them choose between connecting one and the free flow. Never improvise a provider or ask for a key. `libi.list_providers()` shows what is connected without putting a card in the chat.

(B) adds to (A) rather than replacing it: its script has no boxes and no word timings, so run (A) as well for tracking or cataloging, and `audio-analysis` for word-level captions.

## Frames

1. **Extract** with `libi.analysis_extract` action `frames` (the schema has the arguments; the judgment is how many). Density matters when the subject will be tracked: about one frame every 3 s under 5 minutes (`count` about `ceil(durationSec / 3)`), one every 10 s beyond; request explicit `timestamps` for specific moments. Dense anchors are what hold identity through duets and crowds. Use this tool for all frame inspection, never `libi.generate_thumbnails`: extracted frames stay in the analysis Frames tab out of the way, while thumbnails land as throwaway JPGs in the piece's assets.
2. **Describe** each frame (`frame_v1`; the required fields and their types are in `references/shapes.md`, because the tool's schema does not list them). The ones that matter: `scene`, `people[].name` for identifiable subjects, `objects[].name`, `tags`, `text_on_screen`, `shot`. For any person or object the user might track later, include `bbox`: estimate it from the full source frame, not the thumbnail you see, and know that a missing box leaves the tracker with no anchor on that frame. Do it for trackable products, logos and props too.
3. **Record text treatment, not only wording**, when the video may be recreated: colour, glow, weight, position, and whether the text is flat (level baseline, constant size, parallel to the screen) or in the scene's perspective (on a road or floor, anchored at the vanishing point, tilting with the surface, growing toward the camera). One still cannot show the animation, so for a caption whose look matters extract three or four frames across its on-screen window and compare: growth, recession or movement means it is animated. Record the motion, but do not rule "flat 2D" versus "3D" yourself: a scale punch and a dolly toward the camera look the same in a still, and that call belongs to the recreation step, which asks the user.
4. **Save** in batches of 10-20 with `libi.analysis_save` action `frames` (upsert by frame index; nothing is deleted). To re-extract at another density, clear first with `libi.analysis_save` action `remove_step`. Mark unusable frames (black, blurred) skipped with a reason.

## Summary

Read what exists with `libi.analysis_query` action `get`, compose a `video_v1` summary (subjects, sections, recurring objects, audio summary, visual style; empty arrays are fine when unknown; shape in `references/shapes.md`) and save it with `libi.analysis_save` action `summary`. If frames or the summary cannot be produced, mark the step failed with `libi.analysis_save` action `step_failed` and a message the user will see.

After saving, take the recurring central subjects (the presenter, the product shown, a named character who reappears) through `using-character-library`'s auto-catalog workflow and report inline; skip one-off extras and generic objects.

## Search

`libi.analysis_query` action `search_frames` filters ready frames by subject, objects, on-screen text, tags, time range or shot; `libi.analysis_query` action `search_transcript` matches transcript words. Use them for "every frame where X appears" and "where does the speaker mention Y".

Browsing, renaming or linking existing catalog entries is `using-character-library`; an audio-only file has no visual fields, so only `audio-analysis` applies.

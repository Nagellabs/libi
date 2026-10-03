# Veo 3.1 — prompt rules

Veo 3.1 gives synchronized audio and is a strong image-to-video and text-to-video engine. Endpoint ids, tiers and input names are in the provider reference; confirm with the schema tool before submitting.

## Seven layers, in this order

Veo weights early tokens most. Target 100–200 words: far over 400 characters it prioritizes elements unpredictably; far under 100 it goes generic.

1. **Camera and lens**: shot type, movement, lens ("handheld medium shot, 35mm, subtle bob").
2. **Subject**: lock it first, with identifying details (age, hair, key clothing) so continuity does not drift. Reference the character image when there is one.
3. **Action and physics**: one dominant action per clip. "She unscrews the cap" works; "she walks in, unscrews the cap, sips, walks out" drifts. Split multi-action shots into separate clips, placed as separate video overlays (`stitching-multi-clip`); joining them into one file is an export concern.
4. **Environment**: place, time of day, props.
5. **Lighting**: specific ("low warm side light from frame-right").
6. **Style and texture**: film stock or grade.
7. **Audio**: dialogue if any, foley, ambience, music tag.

Veo exposes a negative-prompt field on some tiers; when it does, pass what to avoid there (`morphing, malformed hands, extra fingers, watermark`).

## Text

Veo scrambles letters and sometimes burns in subtitles unprompted. Append "no on-screen text, no subtitles, no captions, no signs, no readable text on any object" to every prompt; add real text later as an overlay.

## Timestamp brackets: full Veo 3.1 only

`[00:00-00:02] …` with one shot and one action per bracket is a full-model feature. The Fast tier misparses brackets as missing-attachment references and fails with `no_media_generated`. On Fast, use one transition sentence, and for manipulation beats prefer first/last frame (see `references/physical-action.md`; a 4 s clip beats 8 s).

## Example: body shot

> Tight medium shot, 50mm lens, slight handheld bob. A 30-year-old man with a short dark beard, white tee, light jeans (the character in the reference image) picks up a bottle from a wooden desk and tilts it slightly toward the camera, the glowing blue cap catching the light. Small home office, mid-morning. Warm window light from frame-right, soft fill from a desk lamp on frame-left. Photorealistic, shallow depth of field, fine film grain. Subtle room tone, a soft click as he sets it down. 6 seconds, 9:16 vertical. No on-screen text, no captions, no labels.

# Audio and voice during generation

This is the single owner of how an AI video gets its audio and voice **as it is generated**. The voice comes out of the video generation itself, so the provider that matters is your video one, and in particular whether it offers a reference-conditioned generation (one that takes reference audio and image arrays), which is what carries one voice across clips. A synthesized-speech tool is not a substitute for that, and this reference never calls one. If you have no video provider, the calling skill has already stopped at the provider gate.

Changing the voice on a video that already exists (clone the original, pick a new narrator, dub, lip-sync) is the `voice-replacement` skill, which the user starts after the video exists. Generation-time audio ends at native audio plus the carry below.

## Native audio, always

Set `generate_audio = true` on every clip on an engine that has native audio. The spoken voice is baked into the generation. **Muting an AI generation is a defect**, not a clean result: never set `generate_audio = false` to "add the voice later". A clip that is meant to be silent still keeps `generate_audio = true`, so ambient sound and effects render, and its prompt carries no dialogue.

- **Prompt and flag must agree.** A line written as `She says: "…"` belongs only in a clip generated with audio on. Never write dialogue into a clip you are silencing.
- **Whether the clip has a line at all** is settled once per brief at the voice-line intake in `ai-asset-generation`. "No line" means ambient native audio plus an offered music bed, never a silenced clip.
- **Opt-out is the user's call.** If they say "make it silent" or "I'll add my own voiceover", only then turn audio off and add their track; do not default to silent plus a separate voice, which wastes a generation.
- An engine without native audio (the provider reference says which) needs its sound from elsewhere; say so, and do not treat it as a voice carrier.

## One voice across several clips

Native audio is generated per clip, so timbre can differ between clips. For a target longer than one clip:

1. Generate clip 1 on the ordinary image-to-video path with `generate_audio = true`.
2. Extract its audio with `libi.extract_audio` (it defaults to MP3). Reference audio accepts **MP3 or WAV only**: passing `format: "copy"` stream-copies to AAC, which the engine rejects with HTTP 422. A 422 on a reference call means check the audio format first. Keep the sample to the engine's limit (about 15 s of continuous speech, no music).
3. Generate clip 2 onward on the **reference-conditioned endpoint**, with that file as the audio reference (`@Audio1`) and the character image as the image reference (`@Image1`). The pairing is mandatory: audio alone is rejected. Say the invariant in words beside each token: "keep the voice from `@Audio1`", "the same woman from `@Image1`". Reuse the same `@Audio1` on every clip.
4. This is the standard multi-clip path: attempt it. Do not pre-emptively mute the clips and layer a TTS voiceover.
5. If the carried voice underperforms, show the result to the user and ask first. A different or cloned voice is `voice-replacement`; never silently substitute a VO here.

Keep the chosen sample as a file and link it to the character with `libi.character` action `link` (`using-character-library`) so the same voice runs through other videos.

## Stitching real footage with new AI beats

Reused source clips bring their own voice. Ask the user up front: **reuse the voice from your source, or give the new creator a fresh voice?** Explain what they cannot see: if a reused beat already carries the source creator's voiceover, that voice is the cheapest, most consistent spine for the whole piece.

- **Reuse the source voice (the default when a reused beat has the creator's voiceover).** Keep the original audio on the reused clips, cut one clean sample of it (about 15 s of continuous, music-free speech, MP3, as above) and generate every new talking beat on the reference-conditioned endpoint with that sample as `@Audio1` and the beat's start frame as `@Image1`, `generate_audio: true`. A new on-camera creator is a visual swap; the voice stays the source's. A faceless insert can be voiced the same way, so b-roll carries the creator's voice without showing a face.
- **Fresh voice (when reused beats have no dialogue, or the user wants one).** Generate the first new clip with native audio to establish the voice, extract a sample, and reuse it as `@Audio1` on every other AI beat. Dialogue-free reused clips stay ambient.
- **Match the source speaker's delivery in the prompt.** `@Audio1` carries timbre; pace, energy and cadence of new lines come from the prompt. Read the source's delivery from the transcript and say it ("speaking quickly and energetically, casual fast-paced delivery"), or the new beats sound like a different person even with the same timbre.
- Never put two different voices on one clip: keep the reused clip's own audio only when its voice is the chosen spine; otherwise remove it from that clip.
- Mute real footage's audio only for a deliberate re-voice, which is `voice-replacement`. Never ship silent inserts.

## Local files as inputs

Hosted endpoints need public URLs. Put a local sample or start frame on the provider's storage with the provider's own upload tool, as its reference says; never read a provider key or push bytes to its storage yourself.

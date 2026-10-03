---
name: voice-replacement
description: "Change, replace or dub the voice on an existing video: 'change the voice', 'give it a different voiceover', 'redo the voice', 'dub this', 'clone my voice over it', 'new narrator'. A user-triggered step after the video exists, not part of generating one."
---

# Voice Replacement — re-voice an existing video

Needs a **voice** provider for anything beyond libi's local Kokoro (which is free, needs no key, and cannot clone). Read the `references/providers/<id>.md` here for the provider you use before your first call. With none and a need for one, call `libi.suggest_provider({ kind: "voice" })` and stop; the full rule is `libi.read_manual({ section: "providers" })`.

Done looks like: every video the user chose carries the new voice, the new speech covers what was actually said, on-camera speakers' lips match it, and the original audio is still in the piece, muted, one click from coming back.

This runs only when the user asks to change the voice on footage that already exists. The voice a video is generated with is `video-generation-craft` (`references/voice.md`).

## Constraints

- **Mute the original, never delete it.** `libi.audio_clip({ action: "update", pieceId, clipId, enabled: false })`, not action `remove`: the user can toggle it back, and action `relink_overlay` is the only recovery once it is gone.
- **Cover the speech that was said.** Size each new segment from the transcript's talking time, not a short paraphrase: a line that under-fills leaves the speaker silent on camera. Duration is a ceiling against overflow, not the target. If natural delivery overruns, nudge `speed` or trim filler; never drop content.
- **Lip-sync wherever a face speaks.** A new voice over a visibly talking mouth must be lip-synced, or the user told the lips will not match.
- **Paid means disclose, then wait.** A hosted voice or a lip-sync run costs the user's money: say what you will generate and roughly what it costs, and get a yes first.
- **Never read or handle a provider key.** Local files reach a provider only through that provider's own upload tool (as its reference describes); if a remote MCP cannot read a local path, say so and ask rather than improvising an upload.

## Flow

1. **Scope.** Confirm which video overlays get the new voice (all, or a subset) and list them back before spending anything.
2. **Transcribe** each target with word timings: reuse `libi.analysis_query({ action: "get", fileId })` if a transcript exists, else load `audio-analysis`. Record the spoken text, where speech starts and ends in the clip, and its talking duration.
3. **Choose the voice.** Ask: clone the existing speaker, or a new voice?
   - *Clone* needs a hosted provider that can clone. Cut a clean sample of about 15 s from a continuous, music-free stretch with `libi.extract_audio`, and use the provider reference's cloning route. Keep the sample as a file and link it to the character (`libi.character` action `link`, see `using-character-library`) so it is reusable.
   - *New voice*: match the format and say the trade-off. Social, UGC and talking-head testimonials need expressive delivery, so offer a hosted voice; Kokoro (`libi.generate_speech`) reads flat there. Narration, explainers and how-tos suit Kokoro well, with a hosted voice as a paid upgrade for more expressive or branded delivery. When unsure, state both and let the user pick.
4. **Classify each target.** Is a person's mouth visibly speaking on camera (talking face), or is it hands, product, off-camera narration (voice-only)? Use the analysis (`people[]`, `subjects[]`) or look at the footage.
5. **Apply.**
   - *Talking face:* generate the segment, then lip-sync the clip to it on a hosted lip-sync model (the provider reference names one; libi has no local engine). With no lip-sync model in your tools, call `libi.suggest_provider({ kind: "video", reason: "lip-sync" })` and tell the user what it showed; if they decline, treat the clip as voice-only and say the lips will not match. Put the clip and the new audio on the provider with its own upload tool, run the model, and import the result with `libi.upload_file`. Then swap and re-voice, in this order:
     1. Find the overlay's inline clip (`libi.get_composition`: the clip with `kind: "inline"` and `linkedOverlayId` = the overlay) and mute it: `libi.audio_clip({ action: "update", pieceId, clipId, enabled: false })`. It still plays the original file; `update_overlay` re-times it but never re-links it.
     2. Point the overlay at the synced file: `libi.update_overlay({ pieceId, overlayId, fileId: <synced file id> })`. Keep the original file in the piece and note its id, so the swap reverts by pointing back and unmuting.
     3. Add the synced file's own audio (the new voice, in step with the new lips) as a standalone clip: `libi.audio_add_clip({ pieceId, fileId: <synced file id>, kind: "standalone", startTime: <overlay startTime>, trimStart: <overlay trim.start, else 0>, duration: <overlay duration> })`. Not a second inline clip: only one inline clip per overlay follows a re-time. The standalone clip does not follow the overlay, so tell the user to move the two together.
   - *Voice-only:* mute the clip's inline audio (`libi.audio_clip` action `update`, `enabled: false`), then add the new voice as a standalone `libi.audio_add_clip` at the overlay's own `startTime` (from `libi.get_overlays`).
6. **Verify, then report.** Per target: exactly one audible voice (the new one) with the original clip present but disabled, a new segment that covers the speech, lip-sync done or the disclosure made; untouched clips unchanged. Read `libi.get_composition` back and count the enabled ones covering each target's window. Give the user the final layout (muted original, new segment start and duration, lip-synced yes or no).

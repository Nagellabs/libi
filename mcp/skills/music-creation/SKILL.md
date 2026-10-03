---
name: music-creation
description: "Make music from a short brief: 'make music', 'write a song', 'create a soundtrack', 'background music'; also the music choice in a recreate when the source has a music bed (reuse it or generate new). Skip when the user gave a full prompt (ai-asset-generation). Music under synced lyrics or beat visuals: music-video-creation."
tags:
  - music
---

# Music Creation

Needs a **music** provider: libi's local music extension counts, and is the default; a remote one is on explicit request. Read the `references/providers/<id>.md` here for a remote provider before your first call. With none, call `libi.suggest_provider({ kind: "music" })` and stop (a track the user brings as a file needs no provider); the full rule is `libi.read_manual({ section: "providers" })`.

Done looks like: a track the user approved by its prompt, generated on the provider they chose, attached under their visuals with a deliberate length, and carrying the right rights stamp.

## Build a music brief, ask only what is missing

Take what the request already says and infer the rest. A brief has: the use (background score, song, jingle, beat), genre and mood, vocals or instrumental (and language and voice if vocals), lyrics (written by you and read back for sign-off, or the user's own, under about 2000 characters), tempo and structure, and length (30 s unless told otherwise; warn above 2 minutes, which is slow locally and costly on a paid provider). Ask about the gaps in as few questions as you can, offering a handful of options to react to rather than an open prompt.

If the user names a reference track ("like X"), get the file (`libi.upload_file` if it is not in the piece) and run `libi.music_profile({ fileId })`: free, about a second, and it returns a `suggestedPrompt`, key and descriptors. Paraphrase it back ("around 72 BPM, A minor, mellow") and seed the prompt from it.

**Show the prompt before generating** and get a yes: one string built from genre/mood, instrumentation, tempo, structure and length, starting from the profile's `suggestedPrompt` when there is one.

## Recreating a video that already has music: reuse or generate

When a source video carries a music bed, whether to keep it is the user's decision, made before anything is generated. Offer both and state your default (reuse when they said "the same video" or "keep the music"; generate when they want a different feel):

- **Reuse:** `libi.extract_audio({ fileId: <source video> })`, then `libi.audio_add_clip({ pieceId, fileId: <extracted audio>, kind: "standalone", startTime: 0 })`. It is free and exact. Flag the licensing caveat: it is fine for the user's own or cleared content, but a recognizable third-party song may carry rights issues, and the user decides.
- **Generate in the same vibe:** run `libi.music_profile` on the extracted audio and seed the brief from its `suggestedPrompt`, BPM and key, so the feel matches without copying.

## Provider

Local ACE-Step (`libi.generate_music`) is the default: free, on-device, no key; instrumentals are excellent, vocals decent. A paid `music` provider is an option, never the agent's own initiative: it gives better vocals or a specific style model, and bills the user's own account (`references/providers/<id>.md` says what each offers). Offer it only when the user wants it, or when they want English vocals, or when ACE-Step answered `needs_install` and a paid one would skip the download. Before naming one, check `libi.list_providers()` and your tool list for what is actually connected; if nothing is, say so rather than offering a generic "paid provider".

Generate through `ai-asset-generation` with the approved prompt and provider; it owns the cost disclosure and the import. Then attach the track with `libi.audio_add_clip` so the user hears it under their visuals.

## Rights

Music from libi's own generator is stamped *generated* and stays in social exports. A provider track imported with `libi.import_remote_files` lands as copyrighted: stamp it with `libi.set_audio_rights({ pieceId, fileId, class: "generated" })` (see `social-music`). A song the user downloads or uploads is copyrighted and handled per platform; `social-music` owns that.

## A track longer than the piece

A piece ends where its last clip ends, so a 3:49 track on a 3-second piece stretches the piece, and trimming throws music away. Neither is yours to pick silently. Before `libi.audio_add_clip` with a track that runs past the piece's end, ask whether to extend the piece to the full track, trim the track to the piece, or use a specific length. Then pass `lengthPolicy: "extend"` or `"trim"`, or an explicit `duration`. The tool refuses until one is stated (`asset_longer_than_piece` means the question was skipped); a track that fits needs none. A video overlay that outlasts the piece goes through the same gate on `libi.add_overlay`, where `lengthPolicy` is the only way through.

## Level, dips and splices: set them on the clip, never bake a bed

A track's loudness, its dips under narration, a swell for the end card and the join of two ranges are properties of the clip, not of the file: `gainDb`, volume-envelope keys, `crossfadeMs` and `libi.audio_duck`, the same in the preview and the export, one `libi.apply_ops` for every copy of a piece. Don't mix, boost, fade or splice audio with ffmpeg and re-upload it (an upload and a clip swap in every piece per change, rights re-stamped, nothing the user can tune), and don't decode or measure levels with ffmpeg or numpy: `libi.audio_analyze` (`measure`, `report`, `align`) reads what the piece plays. The manual's audio-clips section (`libi.read_manual({ section: "mcp-tools-audio-clips" })`) owns the shapes and the worked examples.

## Optional: a beat-synced visual

Once a track exists, offer a visual that pulses on the beat. If yes: `libi.music_detect_beats({ fileId })`, then a full-frame code overlay (`libi.add_overlay({ kind: "code" })`) with `const BEATS = [...]` inlined in its `codeFilePath`, driven by the `beatPulse(BEATS, time)` helper. Keep it short, about 12 s. Visuals tied to lyrics or an ongoing music video are `music-video-creation`.

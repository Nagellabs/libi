---
name: music-video-creation
description: "Build a video with music plus visuals tied to it: generate a track, lay it under the picture, synced lyrics, kinetic typography, beat-synced motion, or 'same video, different music'. Music alone is music-creation; captions for existing audio is audio-analysis."
tags:
  - music
  - ugc
---

# Music Video Creation

Needs a **music** provider: libi's local music extension counts, and is the default; a remote one is on explicit request. Read the `references/providers/<id>.md` here for a remote provider before your first call. With none, call `libi.suggest_provider({ kind: "music" })` and stop, unless the track is the user's own file (then nothing to generate: skip to attaching it); the full rule is `libi.read_manual({ section: "providers" })`.

Done looks like: a track under the visuals, on-screen text that comes from one place and lands on the vocal, nothing left over from a previous song, and a result you have looked at yourself. Generating the music is the easy part; keeping the composition coherent as the music changes is this skill's job.

`music-creation` owns the track (its brief, provider choice, rights stamp and the rule for a track longer than the piece), `audio-analysis` owns transcription. This skill owns what appears on screen and how it stays in sync.

## Visuals

If the visuals are AI-generated video clips, plan them as blocks from the song's sections and lyrics (`video-planning`) and build them through the storyboard (`using-storyboard`); one continuous visual moment is one card, not a card per beat. Going direct is only for when the user says to skip the storyboard. If the visuals are lyrics over one image, a beat-pulse code overlay or a single uploaded clip, there are no clips to plan: build directly. The rules below apply either way.

### Order

1. The track: generate it (`music-creation`), use the user's file or the existing one, or find a released song by name: `libi.download_video({ search: "<artist> <title> official audio", candidates: true })` lists the top results without downloading, then download the one the user confirms by its url (`audioOnly: true, pieceId`), and check the `picked` title and length before building on it (never shell out to yt-dlp). To continue a song from a short clip of it, `libi.audio_analyze` `align` gives the clip's offset in the full track (never cross-correlate in numpy yourself).
2. Attach it under the visuals (`libi.audio_add_clip`), resolving the length gate. The same track under several copies of one piece: one `libi.apply_ops` for all of them (the manual's "Batch edits across pieces"), not this step once per piece; a track from the user's disk goes into all of them with ONE `libi.upload_file({ filePath, pieceIds })`, whose `perPiece` result gives each copy its own file.
3. Ask whether they want lyrics on screen, and which kind: per-word reveals, a caption strip, or none. Building lyric text for a song that has none wastes a pass, and the choice decides whether steps 4-5 run.
4. If yes: audit the code overlays for baked-in text (below), then transcribe the track itself with `libi.analysis_transcribe_audio` (`medium` for non-English), since `generate_captions` reads that transcript.
5. Build the visuals and captions, verify, and report which overlay is timed to which audio file.

## The rules

### One source of truth for on-screen text

Text can be drawn inside a `code` overlay (`ctx.fillText`) or be a text overlay. Never run both over the same time range: the usual failure is decorative words baked into a code overlay early on, then the real transcript added as text overlays, and the user sees the decorative words because the code overlay draws on top. Before adding any text overlay, fetch the composition and audit the code overlays that overlap its window for `ctx.fillText`, `ctx.strokeText` or hardcoded word arrays. Either strip the text from the overlay body (keep its gradients, particles and shapes) or decide that text is the lyric and skip the text overlay. Do the audit even for an overlay you wrote five minutes ago.

### Verify before saying done

After adding overlays, `libi.get_composition({ pieceId, view: "timeline" })` and check each exists with the expected `id`, that `startTime + duration` covers the range, that text `content` is non-empty and not the string `"undefined"`, and that a code overlay defines the draw call you expect (`libi.code_outline`, not a read of the whole body). Then look at it: `libi.render_overlay_frames({ pieceId, overlayId, contactSheet: true })` and view the result (the manual's "Putting results in front of the user" covers the rest). With several pieces, never loop: one `libi.get_composition({ pieceIds | folderId, view: "timeline" })` (lines that differ from the first piece are marked), one sheet with `libi.render_overlay_frames({ pieceIds, atTimes })` and one `libi.get_piece_state({ pieceIds })`. Never end with "open Preview to check"; you are the one verifying. For a complex code overlay, ship a minimum visible version first (a solid rect or one hardcoded word), confirm that renders, then build the kinetic typography on top.

### Captions: declarative first

For lyric-following text, prefer `libi.generate_captions` to lay synced lyrics from the transcript in one pass, or one text overlay per Whisper word:

```
libi.add_overlay({ pieceId, kind: "text", content: word.text,
  startTime: word.start, duration: max(word.end - word.start, 0.15),
  rect: { x, y, width, height },   // rotate through 3-6 positions
  z: 10, color, reveal: { mode: "typewriter" } })
```

These render through ffmpeg on export, appear in the overlay list for the user to edit, and are easy to debug. A 3D lyric caption is still a text overlay with `place3d: true` (via `update_overlay`); `three` is for captions genuinely mapped onto footage geometry. Use a single `code` overlay only for motion declarative reveals and effects cannot express (per-word colour cycling, beat sparks), and write the declarative version first to confirm the timing. If refinement stalls on subjective colour or position, hand the user the control (`guiding-manual-edits`).

If the words would be a recognizable copyrighted song's lyrics and you will not reproduce them, do not drop the captions. Ship the scaffold: timing from `libi.music_detect_beats`, vocal onsets or a transcript's timestamps only; full style and effect per slot; placeholder text matching each line's rhythm in editable text overlays; and tell the user the words are blank by design and where to fill them.

### Swapping the music: sweep stale layers first

Transcript overlays, beat-synced code overlays and ducking rules are tied to one audio file, and a swap breaks all of it. Before generating the new track, list what will go stale (counts and ids), then ask whether to (a) drop and rebuild against the new vocals, (b) keep as is (out of sync but visible), or (c) keep and retime by shifting (only if the tempo is similar). Skip the question only when the request already names the disposition ("drop it", "keep the captions but retime"); "swap the music" alone is not one. When you rebuild captions, carry the user's per-overlay tweaks (size, colour, anchors) over to the new set.

### Word sync: peak on the vocal onset, no lead offset

Whisper's `word.start` is when the vocal begins; an entrance ramp that starts there peaks before the word is sung. Either step the appearance (invisible before `word.start`, fully visible from it, the default for declarative text), or start the ramp at `word.start - ramp` so it peaks on the onset (ramp 80 ms, never over 150 ms). Never add a global lead offset ("+50 ms to feel natural"): it compounds with animation phase into drift. A phrase cue's 0.15 s window lead (`speech-captions`) is a different thing and fine; this rule is about word entrances. If the user reports sync trouble, diagnose a specific word ("at 2.4 s 'Dale' shows about Xms early") rather than shifting everything.

### Non-English vocals: use `medium`

Whisper `small` mis-hears non-English lyrics enough that typos slip into captions. When `libi.analysis_transcribe_audio` reports a language other than `en`, transcribe with `model: "medium"` (`audio-analysis` has the install and download-confirmation steps), and drop the known tail hallucinations Whisper adds after the audio ends ("Subtítulos por la comunidad de Amara.org" and kin; they have very late timestamps). If `language_probability` is below 0.85, say so and offer `large-v3`, a bigger download, never escalated silently; heavy vocal genres often score 0.80-0.85 even on the right language.

### A/B variants: a muted second track

When the user wants to choose between songs, add the new one as a second clip and mute it by default so they A/B by toggling:

```
libi.audio_add_clip({ pieceId, fileId: newTrackId, startTime: 0, volume: 1.0, enabled: false })
```

Name the dependency: "A (playing): <description, file id>. B (muted): <description, file id>. The lyric overlays are timed to A; if you pick B, I'll re-transcribe it and rebuild the captions." Otherwise they export B with captions that are gibberish against the new vocal.

### Length and housekeeping

A bed that must sit louder, dip under a voice or join two ranges of the song is set on its clip (gain, volume keys, crossfade), never baked into a new file: `music-creation` owns that rule.

A track longer than the piece hits the `lengthPolicy` gate: ask whether to extend the piece, trim the track or use a set length, never choosing silently (`music-creation` has the details). Candidate tracks go in one asset folder, not loose files (the manual's "Drafts, copies and asset folders"); that section also covers asking before committing a draft.

## Iterating

"Another option" or "make it better" with no hint: ask one question (different genre, cleaner vocals, more energy, shorter?). "Make it X instead" is the swap rule, then regenerate and rebuild captions. "Give me a choice" is the A/B rule.

Across a session: after the second generation on a piece, say how many tracks exist and offer `libi.delete_file` for the superseded ones (ACE-Step writes 48 kHz stereo WAV, about 0.2 MB per second: a 2-minute track is roughly 23 MB, so five iterations is over 100 MB). Before any generation over 120 s, warn that local time is non-linear (about 100-120 s for 2 minutes on an M-series CPU). After four or more generations in a session without a keeper, mention a paid `music` provider (`references/providers/<id>.md`) as an option, with cost disclosed and the user's approval, never on your own initiative.

## Common mistakes

| Mistake | What goes wrong | Instead |
|---|---|---|
| Decorative lyrics baked into a code overlay before the transcript exists | Stale text fights the real overlay later | Code overlays behind lyrics carry no text |
| A `code` overlay for word-by-word captions where `reveal` and effects would do | No fallback if it will not render, nothing to tune later | Declarative text first |
| A "+50 ms lead to feel natural" | Drift compounds with animation phase | No global offsets |
| "Open Preview to check" as verification | "I don't see it" after you said done | You verify |
| New track without sweeping old captions | Out-of-sync text on the new audio | Sweep, then generate |
| Whisper `small` on Spanish lyrics | Hand-corrections, and some typos missed | `medium` for non-English |
| Replacing a track when asked for "another option to choose between" | The first option is lost | Muted second track |

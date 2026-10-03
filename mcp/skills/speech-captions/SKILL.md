---
name: speech-captions
description: "Add subtitles synced to speech: 'add captions', 'subtitle this', 'sync the caption to her speech', in a chosen style (cumulative, word-by-word, karaoke, letter-by-letter), from the file's word timings. For decorative non-speech animated text use animated-text-overlays."
tags: [overlays, text, captions, audio]
---

# Speech captions (synced subtitles)

Done looks like this: a caption track whose words appear when they are spoken, fully on screen,
readable over the footage, in the style the user asked for (or cumulative by default), with the
style named in your reply. Readability and sync matter more than animation here.

A caption track is one structured text overlay per cue, each with its own `startTime` and
`duration`, all sharing a `caption.groupId`. There is no draw function and no code file.

## Build it

1. **A transcript with word timings must exist.** Prefer an existing transcript of the spoken
   clip (`libi.analysis_query` action `get`); otherwise run `audio-analysis` first (`libi.analysis_transcribe_audio`; local Whisper gives word timing). With
   plain text only, sync is approximate: say so.
2. **One call builds the track:** `libi.generate_captions({ pieceId, fileId, style?, anchor? })`.
   It reads the file's per-word timings and makes readable, non-overlapping, width-budgeted cues
   (at most two lines), placed canvas-aware so they never overflow the frame bottom. Re-running
   replaces the same track in place. It returns `{ captionGroupId, cueCount }`; a `cueCount` of
   `0` means no track exists (any earlier one for this file was removed): read the `hint` and
   tell the user why.
3. **Check by looking.** Render three moments that fall inside cue windows (a cue start, a
   mid-cue, a late cue; read them off the word timings, not silence) with
   `libi.render_overlay_frames({ pieceId, atTimes })` and view each frame. The text must be fully
   on screen at every edge, sit where the user asked, show the right words at the right time
   with nothing in silence, and hold until after the last spoken word of each cue. In an
   animated style the reveal must move between frames. An unrendered caption is unverified.

## Style

Pass one `style`; each carries its look and a `reveal.mode`. Honour explicit requests ("highlight
each word" is karaoke, "type it out" is letter-by-letter).

| `style` | `reveal.mode` | Effect |
|---|---|---|
| `cumulative` (default) | `fade-words` | Words fade in one after another and hold; the most readable follow-along |
| `word-by-word` | `word-current` | Only the active word shows |
| `karaoke` | `karaoke` | The full cue shows, the active word in `reveal.highlightColor` |
| `letter-by-letter` | `typewriter` | Letters appear as each word is spoken, holding during pauses |

All of these follow the real per-word timings `generate_captions` stores on each cue
(`caption.words`), in 2D and 3D alike. Never hand-author per-word offsets.

When the user asks for a specific look (colour, stroke, font), set it, and once it is right
offer to save it as a reusable style with `libi.caption_style({ action: "create" })`. Ask first; never create
styles unprompted.

## Edit and refine

- Restyle the whole track: re-run `generate_captions` with a different `style` or `anchor`.
- Change one cue: `libi.update_overlay({ pieceId, overlayId, content?, startTime?, duration?,
  reveal? })` (find ids with `libi.get_overlays`). Edit, never recreate.
- If the user wants to tweak a caption's look themselves, point them at the control with
  `libi.highlight_property` and load `guiding-manual-edits`.
- To re-split or re-time cues (at commas, shorter lines), give each cue its new text and
  timing in `libi.update_overlay({ ..., content, startTime, duration, captionFromFileId })`.
  For more cues, `libi.add_overlay({ kind: "text", content, startTime, duration })` then the
  same update; the new cue joins the file's track and takes its nearest neighbour's look. For
  fewer, `libi.remove_overlay`. Start each cue at or just before its first word and end it by
  the next cue's start. If the text does not match the words heard in the window, the result
  carries a `note`: fix that cue's timing. Never re-run `generate_captions` to restore sync
  after this; it rebuilds the track and discards the re-split.
- Timing for any text that labels speech is in `prompts/timing-contract.md`; line width and
  placement defaults are in `prompts/readability.md`.

## Custom code or three captions that stay word-accurate

If the built-in styles cannot express the look: create the overlay (`libi.add_overlay({ kind:
"code" | "three", body })`), then attach the transcript with `libi.update_overlay({ pieceId,
overlayId, captionFromFileId })`. That stores the file's words, mapped to the timeline and
windowed to the overlay, as `caption.words` (element-local). In the body, read the injected
`words` and element-local `time` through the same helpers the built-in reveals use:
`activeWordIndex`, `currentWord`, `cumulativeLabel`, `typewriterRevealedText`,
`fadeWordsAlphaByTime`. Never embed a per-word timing array in a body: it drifts from the
transcript and does not survive a re-transcribe.

## Guardrails

- Subtitles are flat 2D: upright, centred, readable. Never enable `threeD`, tilt or depth on a
  cue, even for a "stylish" look; use reveal mode, colour, stroke or plate, and font. A 2D
  in-plane rotation is fine. A 3D, road or fly-through caption the user explicitly asks for is
  `three-overlays` or `animated-text-overlays`, not synced subtitles.
- One text overlay per cue: do not also add a static text overlay for the same lines.
- Always a stroke outline or background plate, so captions read over bright and dark footage.

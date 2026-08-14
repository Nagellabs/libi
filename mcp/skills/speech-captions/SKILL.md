---
name: speech-captions
description: Add subtitles/captions synced to spoken audio — one call to libi.generate_captions builds a styled, time-synced caption track from the file's word-level timings (local Whisper STT), in a chosen STYLE (cumulative / word-by-word / karaoke / letter-by-letter). State the style in the result. Use for "add captions", "subtitle this", "sync the caption to her speech". For decorative (non-speech) animated text use animated-text-overlays.
tags: [overlays, text, captions, audio]
---

# Speech Captions (synced subtitles)

Use this when the user wants **subtitles synced to speech** — not decorative
text. Concern #1 is readability + sync, not animation.

Captions are **structured text overlays grouped into a caption track** — one
text overlay per cue, each with its own `startTime` / `duration`, all sharing a
`caption.groupId`. There is no JS draw function to author or validate and no
per-overlay code file. The fast path is `libi.generate_captions`, which builds
the whole track in one call from the file's existing word timings.

## Workflow

1. **Ensure a transcript exists.** Captions need word-level timings. Prefer the
   `video-analysis` transcript for the spoken clip; if none exists, run the
   `audio-analysis` skill first (local Whisper → word-level timing). With only
   plain text available, sync will be approximate — state this to the user.

2. **Generate the caption track in ONE call:**

   ```
   libi.generate_captions({
     pieceId,
     fileId,                  // the video/audio file whose transcript drives the cues
     style: "cumulative",     // a caption STYLE = reveal mode (see the style map below); default "cumulative"
     anchor: "bottom-center"  // 3×3 numpad placement; default bottom-center
   })
   ```

   It reads the per-word timings (`analysis_get_audio_chunks` under the hood),
   builds readable, non-overlapping cues (lead + hold, width-budgeted, ≤2
   lines), and creates one text overlay per cue sharing a per-file
   `caption.groupId`. The `style` you pass sets the **reveal mode** on every cue
   (cumulative→fade-words, karaoke→karaoke, word-by-word→word-current,
   letter-by-letter→typewriter) — this is what makes the caption actually
   animate. Placement is canvas-aware: cues are authored in the point-text model
   (bottom-safe anchor + canvas-scaled font) so they never overflow the frame
   bottom, on any resolution. Re-running **replaces** the same track in place (no
   duplicates). Returns `{ captionGroupId, cueCount }`. No manual cue math, no
   per-cue `add_overlay` loop.

3. **Refine (optional).**
   - Restyle the WHOLE track: re-run with a different `style` (or use the
     caption-style tools where available) — every synced cue updates together.
   - Edit ONE cue's text/timing: `libi.update_overlay({ pieceId, overlayId,
     content?, startTime?, duration?, reveal? })` — rediscover overlay ids with
     `libi.get_overlays`.
   - **When the user wants to hand-tweak a caption's LOOK** (not re-run the whole
     track), point them at the exact control rather than only re-generating: use
     `libi.highlight_property` to surface the field they want to change (color,
     stroke, font, anchor) and lean on the **`guiding-manual-edits`** skill to
     walk them through the inspector tweak.

4. **Verify by LOOKING at rendered frames — do NOT trust the overlay data
   alone.** After generating (or restyling) captions you MUST render real
   composition frames and open them, exactly like the overlay build→render→look
   loop:

   ```
   libi.render_overlay_frames({ pieceId, atTimes: [t1, t2, t3] })
   ```

   Pick 3 timestamps that land INSIDE cue windows (a cue start, a mid-cue
   moment, and a late cue) — read them off the `cueCount`/word timings, not
   silence. Then **OPEN each returned PNG `path` with your Read tool and look**.
   Confirm, by eye:
   - the caption text is **fully on-screen and not cut off** at any edge
     (especially the bottom) and is readable over the footage;
   - it sits where the user asked (default: bottom, centered);
   - the right words show at the right moment, nothing shows in silence, and each
     cue holds until **after** its last spoken word (a caption that clears
     mid-phrase reads as a glitch — see `prompts/timing-contract.md`);
   - for an animated style, the reveal is actually moving between frames (e.g.
     karaoke: the highlighted word advances; word-by-word: only the active word
     shows; letter-by-letter: more characters each frame).

   If anything is wrong (cut off, mispositioned, wrong timing, no animation),
   FIX it (re-run with a corrected `anchor`/`style`, or `update_overlay` a single
   cue) and render again. Only move on once the frames look right. A caption you
   generated but never rendered-and-looked-at is **unverified**.

5. **State the chosen style** in your final result message to the user.

### Manual fallback (only if `generate_captions` is unavailable)

If you must build cues by hand: call `libi.analysis_get_audio_chunks({ fileId })`
for the raw per-word `start`/`end` (already absolute, source-relative seconds —
do NOT reverse-engineer boundaries from `analysis_search_transcript` windows).
Build `{ text, start, end }` cues (≤ ~6 words, break on clause boundaries not
mid-word, size each line to the canvas `width` per `prompts/readability.md`,
`start = firstWordStart − ~0.15s` but never before the prior cue's `end`, and
`end = lastWordEnd + ~0.3–0.5s` hold computed from the LAST word — never a
guessed fixed duration). Then add one `libi.add_overlay({ kind:"text", content,
startTime, duration, rect, z, reveal:{ mode } })` per cue at a shared
bottom-safe rect, with a `stroke` outline or `background` plate for readability.
This is exactly what `generate_captions` automates.

## Caption styles → reveal modes

Pick one style. Default to **cumulative** unless the user asks for something
specific, or the context clearly calls for another (e.g. "highlight each word"
→ karaoke; "type it out" → letter-by-letter). The `style` param on
`generate_captions` selects a bundled caption style; each style carries its own
look **and** reveal mode. Always state the chosen style in your final result.

| Style | `reveal.mode` | What it does |
|---|---|---|
| **cumulative** *(default)* | `fade-words` | The cue's words fade/rise in one after another and hold — the most readable "follow along" caption. |
| **word-by-word** | `word-current` | Only the currently-active word of the cue shows, replaced as time advances. Punchy, minimal. |
| **karaoke** | `karaoke` | The full cue is shown the whole window; the active word is emphasized in `reveal.highlightColor` (default gold). "Show the full sentence but emphasize each word." |
| **letter-by-letter** | `typewriter` | Letters appear as each word is actually spoken — the caret tracks the voice, holding during pauses instead of typing ahead. |

**Every word-synced mode is voice-accurate.** `generate_captions` stores the
real per-word STT timings on each cue (`caption.words`, element-local), and the
renderer drives `karaoke` / `word-current` / `fade-words` / `typewriter` off
THOSE — the highlighted/typed word lands on the word actually being spoken (with
a ~80ms read-ahead so it reads tight), NOT on an even-spacing guess. This holds
in 2D **and** 3D text. You supply the cue text + window; the per-word timing is
carried automatically — never hand-author per-word offsets.

Honor explicit style requests. "Make it like karaoke" / "highlight the words" →
karaoke; "type it out" / "letter by letter" → letter-by-letter.

**Offer to save a requested look as a reusable style.** When the user asks for a
specific caption look (a particular color + stroke + font treatment), set it AND,
once it's right, **offer (consent-first) to save it as a reusable style** via
`libi.create_caption_style` — it appears in the **Style tab** for one-click reuse
on future caption tracks. Ask before saving; don't create styles unprompted.

## Timing contract

Each cue overlay's `startTime`/`duration` define WHEN it's on screen; the
`reveal.mode` paces word emphasis WITHIN that window off element-local time
(0 at the overlay's `startTime`). Put **absolute** seconds in each overlay's
`startTime`/`duration`; the renderer handles the element-local remap. See
`prompts/timing-contract.md` for the cover-the-phrase + hold rules.

## Custom code / three caption overlays (voice-synced)

If the user wants a **custom-coded** or **3D** caption that the built-in styles
can't express, it can STILL be word-accurate — never fake the timing:

1. Create the overlay: `libi.add_overlay({ kind: "code" | "three", body })`.
2. Attach the transcript: `libi.update_overlay({ pieceId, overlayId,
   captionFromFileId: "<the spoken file's id>" })`. This reads that file's STT
   words, windows them to the overlay's `[startTime, startTime+duration]`, and
   stores them as `caption.words` (element-local). The transcript is the source
   of truth; this is just the derived snapshot.
3. In the draw body, read the injected `words` + element-local `time` and use the
   provided helpers — `activeWordIndex(words, time)` (karaoke),
   `currentWord(words, time)` (word-by-word), `cumulativeLabel(words, time)`,
   `typewriterRevealedText(words, time)` (letter-by-letter),
   `fadeWordsAlphaByTime(words, time)`. These are the SAME functions the built-in
   reveals use (element-local, ~80ms read-ahead).

**Never embed a per-word timing array literally in a code body.** That copy
drifts from the transcript and won't survive a re-transcribe. Attach via
`captionFromFileId` so there is one source and one snapshot.

## Guardrails

- **Subtitles are FLAT 2D.** A synced subtitle is always upright, centred, and
  readable — never enable `threeD` / tilt / depth on a caption cue, even if the
  user asked for a "stylish" or "kinetic" look. Style it via reveal mode, color,
  stroke/plate, and font — not 3D. (2D in-plane rotate on the Transform tab is
  safe if a slight tilt is wanted; depth/edge-on tilt is not.) For a genuinely
  3D / road / fly-through caption look that the user explicitly requests, that's
  the `three-overlays` / `animated-text-overlays` path, not synced subtitles.
- **Don't double-render.** One text overlay per cue; do not also add a static
  text overlay for the same lines.
- **Safe area + contrast:** always a stroke outline or background plate (see
  `prompts/readability.md`). Captions must read over bright and dark footage.
- **Edit, don't recreate.** To tweak a caption after adding it, call
  `libi.update_overlay` (rediscover ids with `libi.get_overlays`) — or re-run
  `generate_captions` with a different `style`/`anchor` to redo the whole track.
  There is no code file for a structured caption.

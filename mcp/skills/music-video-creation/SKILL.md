---
name: music-video-creation
description: Build a music video — generate a track, attach it under
  the visuals, optionally render synced lyrics on screen, and iterate
  cleanly when the user wants a different song. Encodes the composition
  rules that prevent stale text, double-rendered lyrics, off-by-200ms
  caption sync, and "I don't see anything" surprises.
when_to_use: User asks for a video with music PLUS something visual on
  screen tied to that music — lyrics, captions, kinetic typography,
  beat-synced motion, or "make the same video but with different music".
  Pure music generation (no video) → use `music-creation` directly. Pure
  caption work on existing audio (no new music) → use `audio-analysis`.
tags:
  - music
  - ugc
---

# Music Video Creation

The hard part isn't generating the music. It's keeping the rest of the
composition coherent as the music changes. This skill is the rulebook
for that.

**You delegate the music interview to `music-creation` and the
transcription to `audio-analysis`.** Your job is composition hygiene:
deciding what text appears on screen, removing stale layers, syncing
captions correctly, and verifying the result before you say "done".

## The Storyboard is the build spine for AI-generated visuals (default — not optional)

When the music video's visuals are **AI-generated video clips** (not just lyrics /
captions over a single static or canvas scene), you build those visuals **through the
Storyboard** — invoke `using-storyboard` and follow it. It is the default, not an
optional planning step. First **plan the visuals as building blocks via `video-planning`**:
decompose the song's section/lyric structure into visual blocks (each block's content,
source-vs-AI, combine-vs-split, and style inheritance between consecutive looks) before
authoring cards. The blocks map 1:1 to storyboard cards.

**Card = a generated clip = a timeline scene; a beat is a jump-cut INSIDE a card.** A
music video is usually several distinct visual moments → several cards (each its own
generated clip), placed via `libi.attach_storyboard_clip` + `libi.select_storyboard_take`;
do NOT fragment one continuous visual into many tiny per-beat cards. For each card:
schematic → generation spec (keyframe + clip params) → `libi.show_storyboard` → schematic
approval (free pre-spend gate) → generate → validate → select-take. Use
`set_storyboard_reference` `reference_video` to keep the look/character continuous between
consecutive visual cards.

**Opt-off is a rare, explicit user exception** — ONLY if the user directly says "skip the
storyboard / just generate" do you drop to direct generation. Never your default.

**When the visuals are NOT AI video** — lyrics/captions over one static image, a canvas
beat-pulse scene, or a single uploaded clip — there are no AI video clips to plan, so the
storyboard does not apply; build that scene directly. The seven composition-hygiene rules
below (on-screen text, caption sync, music swaps) are UNCHANGED and layer on top of whatever
scenes exist — storyboard-placed or canvas.

## The seven rules

### Rule 1 — One source of truth for on-screen text

A composition can render text from two places:
- **Inside a scene's draw function** (`ctx.fillText(...)` baked into the canvas code)
- **As a text overlay** (`libi.add_overlay({ kind: "text" })` — declarative, one per phrase)

**Never run both at the same time on the same time range.** Pick one
source and stay with it. The most common failure mode: the agent bakes
decorative words into a scene during early iteration ("mi amor", "baila"),
then later adds the real transcript as overlays — and the user sees the
decorative words instead, because the scene draws on top.

**Before you add any text overlay**, fetch the composition and audit
scenes that overlap the overlay's time window for `ctx.fillText`,
`ctx.strokeText`, or hardcoded word arrays. If you find any, either:

1. Update the scene to remove the text drawing (preserve the visual
   atmosphere — gradients, particles, shapes), OR
2. Decide the scene's text IS the lyric and skip the overlay.

Do this audit even if you're the one who wrote the scene 5 minutes ago.
You forget.

### Rule 2 — Verify placement before reporting "done"

After adding any overlay or text-bearing scene, call
`libi.get_composition({ pieceId })` and confirm:

- The overlay/scene exists with the expected `id`
- Its `startTime + duration` covers the range you intended
- For text overlays: the `text` field is non-empty and not the literal
  string `"undefined"`
- For code overlays / scenes: the draw function source contains the
  expected `ctx.fillText` (or other draw call) and references the
  variable you think it does

If anything is missing or wrong, fix it before responding to the user.
**Do not** end your turn with "Pop open Preview to see it" as your
verification. You're the one verifying.

For complex code overlays where structure-check isn't enough, ship a
**minimum viable visible** first — a solid color rect or a single
hardcoded word — confirm THAT renders by asking the user, then build
the kinetic typography on top of the known-working base. This is one
extra round-trip but catches "the whole overlay system isn't drawing"
before you've written 200 lines of animation code.

### Rule 3 — Caption tool ladder: declarative first, code only when needed

For lyric-following text (one word at a time, subtitle strip, karaoke
highlight), prefer **`libi.generate_captions`** to lay synced lyrics
from the transcript in one pass, or fall back to **N declarative text
overlays — one per Whisper word**. They render through ffmpeg on export
(no JS execution), they show up in the per-overlay list in Resources for
the user to edit, and they're trivial to debug.

```
for each word in transcript.words:
  libi.add_overlay({ kind: "text" })({
    pieceId,
    text: word.text,
    startTime: word.start,           // see Rule 5 for the exact value
    duration: max(word.end - word.start, 0.15),  // floor so brief words register
    anchor: "bottom-center",         // pick anchor; rotate through 3-6 positions
    position: { x, y },
    z: 10,
    color: ...,                      // + stroke / background for legibility
    reveal: { mode: "typewriter" },  // declarative kinetic reveal (no code)
  })
```

A **3D lyric caption** (depth, tilt, perspective look) is still
`kind:"text"` + `place3d:true` (set via `update_overlay`) — NOT a `three`
overlay. Reserve `three` for captions genuinely mapped onto footage
geometry.

Only reach for a **single `code` overlay** when you need motion that
declarative reveal modes + effects can't express — color cycling per
word, beat-synced spark bursts, smooth-interpolated position morphing,
etc. Even then, write a declarative version FIRST and use it to confirm
timing is right before swapping in the code overlay.

If declarative refinement stalls — the user keeps saying "not quite" on a
subjective color/position/size — hand them the control instead of
guessing: see `guiding-manual-edits` (`libi.highlight_property` flashes
the exact field). The agent's own placements should go through those same
controller fields so the hand-off stays possible.

**Copyright fallback (when you decline to put a copyrighted song's lyrics on
screen).** If the captions would be a recognizable copyrighted song's lyrics
and you won't reproduce the words, do NOT drop the captions — ship the full
**scaffold** and let the user type the words:
- **Timing** from something other than the lyric text — `libi.music_detect_beats`,
  vocal onsets, or (if a Whisper transcript exists) its **timestamps only**.
- **Full style + effect** at each slot (the look isn't copyright-encumbered).
- **Placeholder text** per line matching the song's phrase rhythm / word count
  (`● ● ●`, `[lyric]`, syllable blanks) in **editable** text overlays.
- Tell the user you left the words blank by design and how to fill them in
  (click to edit in Preview, or list overlay id + start time per line).

### Rule 4 — When swapping the music, sweep the stale layers first

Every transcript overlay, beat-synced scene, audio-track ducking
setting, and lyric-bearing scene is **time-coupled to a specific audio
file**. When the user asks to replace the music, that coupling breaks.

**Before generating the new track**, list what will go stale:

```
"Switching the music will leave these stale on the timeline:
 - 94 text overlays timed to the reggaeton track's vocals (`18ef9b69`)
 - 'Beat pulse' scene driven by that track's beat array
 - audio_duck rule on the bg track that's targeting the reggaeton clip

 After I generate the new track, want me to:
   (a) drop the overlays + ducking and rebuild against the new vocals
   (b) keep them as-is (they'll be out of sync but visible)
   (c) keep but retime by shifting (if the new track is similar tempo)?"
```

Get the answer. Then generate. Then act on the answer.

**Skip the prompt only when the user's disposition is already explicit**
in the current request — e.g. they said "drop it entirely", "keep the
captions but retime", "swap the music but keep everything else". Map
the verb to (a)/(b)/(c) and proceed. Don't ask again. But if the
request is ambiguous ("replace the music with X", "swap to reggaeton")
— that's not explicit disposition. List the stale layers and ask.

When you do drop captions and rebuild from a new transcript, carry
forward any per-overlay user preferences (font size bumps, color
overrides, anchor preferences) that were applied to the old set.
Don't make the user re-tweak the same knobs across iterations.

If the user said "give me an A/B option" (a SECOND track alongside the
first, not a replacement), this rule doesn't fire — see Rule 7.

### Rule 5 — Word-sync: align peak to vocal onset, no lead offset

Whisper's `word.start` is the **timestamp the vocal begins**. If you
animate an entrance ramp (fade-in / scale-up / position-slide) starting
AT `word.start`, the visual peak lands BEFORE the vocal — by however
long your ramp is. Users perceive this as "the word is showing before
it's said".

Two acceptable fixes; pick one and stay consistent:

**A. No entrance ramp.** Step appearance — the overlay is invisible
   before `word.start`, fully visible from `word.start` onward. Cleanest.
   Use this for declarative text overlays (Rule 3 default).

**B. Delayed entrance.** If you want a fade-in/pop, start the overlay
   AT `word.start - rampDuration` and finish the ramp AT `word.start`.
   The peak coincides with the vocal. Common ramp: 80ms; never exceed
   150ms or it becomes perceptible drift even with the offset.

**Never add a global lead offset** ("+50ms to feel natural", etc.). You
will introduce drift that compounds with any animation phase. Trust the
Whisper timestamps. If the user reports sync issues, diagnose against
a specific word ("at t=2.4s the word 'Dale' shows ahead of the vocal by
~Xms") rather than adjusting a global offset.

### Rule 6 — Non-English transcripts use Whisper `medium`

Whisper `small` is the project default for English. For Spanish,
Portuguese, French, German, Japanese, etc., its word-error rate is
noticeably higher and you end up hand-correcting common mistakes
(`Mal` → `Mami`, `embo` → `dembow`, dropped apostrophes on `pa'`).
That's wasted time AND it's error-prone — you'll silently leave some
typos in the captions.

If `language` from `libi.analysis_transcribe_audio` is anything other
than `en`, switch to `medium`:

```
1. libi.whisper_list_models     // confirm `medium` install state
2. If not installed: disclose ~1.5 GB download, get user OK,
   libi.whisper_download_model({ model: "medium" })
3. libi.analysis_transcribe_audio({ fileId, model: "medium" })
```

Also filter the well-known Whisper hallucinations at the tail (Spanish:
`"Subtítulos por la comunidad de Amara.org"`, Portuguese: `"Legendas
pela comunidade Amara.org"`, etc.) — these appear after the actual
audio ends, with very late timestamps.

**If `language_probability` from the response is < 0.85**, mention it
to the user along with the option to escalate to `large-v3` (~3 GB
download). Heavy vocal genres (reggaeton, trap, autotune) often score
0.80–0.85 even on the right language — large-v3 closes most of that
gap. Don't escalate silently; the larger model means a bigger
download.

### Rule 7 — A/B variants: muted second track + name which overlay belongs to which

When the user wants to pick between songs, don't replace the first —
add the new one as a SECOND audio track and **mute it by default** so
the user A/Bs by toggling speakers:

```
libi.audio_add_clip({ pieceId, fileId: newTrackId, startSeconds: 0,
                      volume: 1.0, mute: true })
```

Then explicitly tell the user:

> "Option A (playing): \<one-line description, file id\>. Option B
> (muted): \<one-line, file id\>. The lyric overlay is timed to A — if
> you pick B, say the word and I'll re-transcribe B + rebuild captions
> against its timestamps."

This naming makes the dependency explicit and prevents the user from
picking B, exporting, and being confused when the captions are
gibberish relative to the new vocal.

### Rule 8 — Snapshot/Draft awareness

Before starting, call `libi.get_piece_state({ pieceId })` and check `hasDraft`. If a draft exists with unrelated work, follow `using-snapshot-draft` Rule 2 (ask about commit/discard/fold).

After completing each major phase (e.g., music generated, scenes built, overlays placed), suggest committing: *"Want me to save this as a snapshot before we move on?"*

### Rule 9 — Music candidates: group in a folder, not loose files

When generating 2–3 candidate tracks for the user to choose from (e.g. the user says "give me a few options"), keep them together in a folder rather than scattering three unrelated files. Create one folder via `libi.create_asset_folder({ pieceId, name: "music candidates" })`, then import each track with that `folderId`. Use `libi.show_asset({ pieceId, fileId })` so the user can audition the candidates, and reference the chosen track's `fileId` directly when you attach it to the timeline. See the `using-asset-folders` skill for the full workflow.

## The flow

```
0. SOURCE MUSIC?       → recreate/mimic with an existing music bed:
                         `music-creation` Stage 0.5 decides reuse-original
                         vs generate-new (ASK). On REUSE: extract the
                         source audio + attach it, and SKIP steps 1+3.
1. INTERVIEW           → delegate to `music-creation` skill
2. PRE-GENERATION      → if replacing existing music: run Rule 4 sweep
3. GENERATE            → music-creation runs ai-asset-generation
4. ATTACH              → libi.audio_add_clip (Rule 7 mute if A/B)
5. LYRICS DECISION     → ask: "want lyrics on screen?
                         (per-word kinetic / static caption strip / none)"
6. IF LYRICS:
   a. Run Rule 1 audit  → remove scene text that would compete
   b. Transcribe        → audio-analysis; apply Rule 6 for non-English
   c. Build captions    → Rule 3 (declarative first), Rule 5 sync
   d. Verify            → Rule 2 (get_composition + structural check)
7. OPTIONAL VISUAL     → if user wants beat-sync, defer to
                         `music-creation` Stage 9 (beat-pulse scene)
8. REPORT              → kept-vs-discarded files, which overlay timed
                         to which audio, any cleanup the user should know
```

## When user asks for "another option" / "make it better"

This is the most common iteration loop. Triage first:

- "Better" with no hint → ask one targeted question: "Better how —
  different genre, cleaner vocals, more energy, or shorter?"
- "Make it X instead" → Rule 4 sweep, regenerate, rebuild captions
- "Give me a choice" → Rule 7 (parallel muted track)

Track campaign state: after the 2nd regeneration on the same piece,
mention disk usage and ask if superseded WAVs should be deleted via
`libi.delete_file`. ACE-Step output is ~2 MB per second of stereo
48 kHz audio; a 2-min track is ~24 MB. Five iterations is 120 MB of
likely-unused WAVs.

## Cost transparency for campaigns

Single-track disclosure is `music-creation`'s job. THIS skill owns
campaign-level transparency:

- After the 2nd generation on the same piece: "That's 2 tracks
  generated. Want me to clean up the unused one before the next?"
- Before any generation > 120s: warn that ACE-Step wall-clock is
  non-linear and a 2-min track typically runs ~100-120s on the local
  CPU (M-series Mac).
- If the user has tried 4+ generations in one session and still isn't
  satisfied, suggest a different provider (elevenlabs for English
  vocals, fal-ai for specific style models) rather than burning another
  ACE-Step run.

## Anti-patterns from past sessions (don't repeat)

| Mistake | What goes wrong | Fix |
|---|---|---|
| Baking decorative lyrics into a scene's draw fn before the real transcript exists | Stale text fights the real overlay later | Scenes don't carry text. Visual atmosphere only. |
| Writing a `code` overlay for word-by-word captions when a declarative `reveal:{mode}` + effects would do | No fallback if it doesn't render, and nothing to highlight/tune later | Rule 3 — declarative `kind:"text"` + reveal first, escalate to code only for motion it can't express |
| Adding a "+50ms lead to feel natural" | Compounds with animation phase, drift is perceptible | Rule 5 — no global offsets |
| Telling user "Pop open Preview" as verification | User reports "I don't see it" after agent claimed done | Rule 2 — agent verifies, not user |
| Generating a new track without sweeping old captions/scenes | Out-of-sync captions on the new audio | Rule 4 — sweep before generate |
| Using Whisper `small` for Spanish lyrics | Manual correction of `Mal`/`embo`/`pa` etc. — and you miss some | Rule 6 — `medium` for non-English |
| Replacing a track when the user asked for "another option to choose between" | User loses the first option | Rule 7 — muted second track |

## Related skills

- `video-planning` — the senior-editor planning/director layer: decompose the song into visual
  building blocks (source-vs-AI, combine-vs-split, style inheritance) before building cards.
- `using-storyboard` — the build spine for the AI-generated VISUALS (cards + schematic +
  generation-spec + take/select). The seven rules here are composition hygiene on top.
- `music-creation` — runs the 10-stage interview (genre, vocals,
  lyrics, length, provider). This skill calls it for Step 1.
- `audio-analysis` — Whisper transcription. This skill calls it for
  Step 6b and applies Rule 6 on top.
- `ai-asset-generation` — the actual generation dispatcher
  (music-creation delegates here at Stage 8; you usually don't call it
  directly from this skill).
- `using-storyboard` — if the user is building a multi-scene
  piece, plan the scenes on the storyboard BEFORE running this skill so the
  beat-syncing / caption-placement decisions have context.

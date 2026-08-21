---
name: music-creation
description: Interview-style music generation. Asks the user about genre,
  vocals, lyrics, length, optional reference track. Dispatches via
  ai-asset-generation skill which routes to local-music (default), or
  elevenlabs / fal-ai on explicit request.
when_to_use: User asks to "make music", "create a soundtrack", "write a
  song", "generate background music" with no detailed prompt provided.
  Also use when deciding the music for a RECREATE / mimic — when a source
  video already has a music bed, Stage 0.5 asks reuse-the-original vs
  generate-new before any generation. Skip if the user already supplied a
  complete prompt — use ai-asset-generation directly. If the user wants
  the music UNDER a video with synced lyrics / captions / beat-pulse
  visuals, use music-video-creation instead (it wraps this skill and adds
  the composition-hygiene rules).
tags:
  - music
---

# Music Creation

> **Related:** when the user supplies a reference track, run
> `libi.music_profile({ fileId })` first to seed the answers — it
> returns a `suggestedPrompt`, `keyEstimate`, and `descriptors[]` you
> can paraphrase in Stage 1.

Walk the user through the music spec one question at a time. Don't
batch — they want to feel heard. Each answer goes into a running
"music brief" you assemble in Stage 8.

## Stage 0 — Frame

Ask: "Is this background music for a video, a standalone song, a short
jingle, or a beat / instrumental loop?" The answer changes default
length + whether vocals are even on the table (a jingle: maybe; a
background score: usually not).

## Stage 0.5 — Recreating a video that already has music? (reuse vs generate — ASK FIRST)

If you arrived here from a **recreate / mimic** flow (or any flow where a **source
video already carries a music bed**), the music is a building block with a
source-vs-generate decision — and that decision is the user's, BEFORE the interview
below. Do NOT silently generate a new track when the source already has one the user
may want to keep.

Present the two paths and ask which they want:

- **Reuse the original track (recommended when faithfulness matters).** Extract the
  source's audio and lay it under the new visuals:
  1. `libi.extract_audio({ fileId: <sourceVideoId> })` → an audio file (wav/m4a).
  2. `libi.audio_add_clip({ pieceId, fileId: <extractedAudioId>, kind: "standalone",
     startSeconds: 0 })` to place it under the recreated visuals.
  Keeps the exact track the user liked; zero generation cost. **Licensing caveat:**
  only reuse the original for the user's own / royalty-cleared content — if the bed is
  a recognizable third-party song, flag that reusing it may carry rights issues and let
  the user decide.
- **Generate a new track in the same vibe.** Run the interview below, but FIRST seed it
  from the original: `libi.music_profile({ fileId: <extractedAudioId> })` on the
  extracted audio and paraphrase its `suggestedPrompt` / BPM / key as the Stage 1 seed,
  so the new music matches the source's feel without copying it.

Pick a default from the user's words — **reuse** when they said "the same video" /
"keep the music" / "mimic / recreate it"; **generate** when they want a different feel —
but state your assumption and let them flip it. When this fork doesn't apply (no source
video, a from-scratch request), skip straight to Stage 1.

## Stage 1 — Reference track? (optional)

If the user mentions an existing track ("make it like X", "vibe of Y"),
ask if they have the file. If yes:

1. Upload via `libi.upload_file` if it's not already in the piece.
2. Call `libi.music_profile({ fileId })` (it's free, ~1s).
3. Paraphrase the profile: *"It's around 72 BPM in A minor, mellow and
   dark, light percussion. Want me to keep that feel?"*
4. Use the profile's `suggestedPrompt` as the seed for Stage 7.

If the file is local but not on disk: `libi.upload_file` first.

## Stage 2 — Genre

Offer 4–6 options to react to instead of an open prompt. Examples by
use-case:

- Background score → ambient, cinematic, lofi, jazz, orchestral, electronic
- Song → pop, rock, indie, R&B, country, hip-hop
- Jingle → upbeat acoustic, retro 80s, corporate-clean, playful
- Beat → trap, boom-bap, drill, lo-fi hip-hop, future bass

Always accept "other — I'll describe it".

## Stage 3 — Vocals or instrumental?

Default depends on Stage 0:
- Background score → instrumental (rarely overridden)
- Song → vocals (rarely overridden)
- Jingle → either
- Beat → instrumental

If vocals:
- Language (default English)
- Voice character: male / female / androgynous / child
- Style: spoken / whispered / sung / belted

## Stage 4 — Lyrics (only if vocals)

Two paths:
- "Write them for me" → ask for theme + 1 line of vibe; you generate
  the lyrics yourself, then read back ~4 lines and ask for sign-off
  before passing to the generator
- "I'll provide them" → cap at 2000 chars; warn at 500 chars about
  audibility for short tracks

## Stage 5 — Length

Default 30s. Warn at >120s (multi-minute generations are slow + costly
on paid providers; even local ACE-Step takes ~10–15s per 8s on CPU).

## Stage 6 — Provider

Disclose cost + quality trade-off:

- **local-music (default, recommended)** — free, on-device, instrumental
  excellent, vocals decent
- **elevenlabs** — paid; best vocal quality especially for English; needs
  ELEVENLABS_API_KEY
- **fal-ai** — paid; specific models (Stable Audio, etc.); needs FAL_KEY

If user has no provider opinion, pick local-music. If they want vocals
and the language is English, mention ElevenLabs as a quality upgrade.

## Stage 7 — Assemble the prompt

Build a single string from the answers. Include (in order):
genre / vibe / mood, instrumentation, tempo (BPM if known or descriptor
like "uptempo"), key (only if reference track), structure (intro / drop
/ outro for songs), duration. If reference profile was used, prefix the
prompt with `suggestedPrompt` and append the user's overrides.

Show the user the prompt before generating. *"I'll send this to
local-music: '<prompt>'. Approve?"*

## Stage 8 — Generate via ai-asset-generation

Invoke the `ai-asset-generation` skill with the assembled prompt and
chosen provider. It handles the approval card and cost disclosure.

On success, attach the wav to the piece via `libi.audio_add_clip` so
the user hears it under their visuals.

## Stage 9 — Beat-synced visual? (optional)

Once a track exists, ask:

> "Want a beat-synced visual? I can call `libi.music_detect_beats` on
> the track and write a full-frame code overlay that pulses on each beat."

If yes: call `libi.music_detect_beats({ fileId })`, then add a code
overlay (`libi.add_overlay({ kind: "code" })`) and write `const BEATS =
[...]` inlined in its `codeFilePath`, using the `beatPulse(BEATS, time)`
helper to drive a visual element. Keep it short (~12s for v1).

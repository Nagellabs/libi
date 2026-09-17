# ElevenLabs — provider reference for `voice-replacement`

ElevenLabs covers the two things this skill needs from a hosted voice provider:
expressive delivery and voice cloning. These tools come from **the user's own ElevenLabs
MCP** — libi does not bundle or configure it. The
generic call discipline shared by every provider (cost disclosure before the first paid
call, the `libi.sleep` polling cadence on a long job, import + `aiGeneration` provenance)
is `ai-asset-generation`'s `references/providers/fal.md` and is not repeated here; only
what ElevenLabs adds is below.

## Cloning

**`voice_clone`** — the only way to clone the original speaker. Feed it a clean **≤15 s**
sample cut with `libi.extract_audio` over a continuous, music-free stretch. Persist the
resulting voice as a per-character voice asset (`using-character-library`) so the same
clone is reusable across pieces.

## Picking a voice

**`list_voices`** to browse, **`text_to_speech`** to generate each segment. The voice is
the choice that matters — the model is implicit.

## Cost

Paid, billed per character / per minute. Disclose and get approval before the first
generation. If the user declines and the format allows it, local Kokoro
(`libi.generate_speech`, free, on-device) is the fallback — but see the format rule in
`SKILL.md`: Kokoro reads as flat on a UGC talking-head.

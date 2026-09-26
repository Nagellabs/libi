# ElevenLabs — provider reference for `voice-replacement`

ElevenLabs covers the two things this skill needs from a hosted voice provider: expressive
delivery, and a voice that follows the original's timing. These tools come from **the user's
own ElevenLabs MCP** — libi does not bundle or configure it. How its tools are called is in
`ai-asset-generation`'s `references/providers/elevenlabs.md`: flow runs,
`generations_count: 1`, the `estimate_only` price and the user's yes before each paid run,
polling, and downloading the short-lived audio URL (the poll's `media[].url`) at once.
Follow it; only what this skill adds is below. The polling cadence and import steps every provider shares are in
`ai-asset-generation`'s `references/providers/fal.md`.

## Cloning

The hosted server has **no cloning tool**. A voice the user cloned in ElevenLabs' own app is
in `creative_list_voices`, so ask them to clone it there and pick it from the list. For that
clone, cut a clean **≤15 s** sample with `libi.extract_audio` over a continuous, music-free
stretch. Otherwise, choose a new voice. Persist the chosen `voice_id` as a per-character voice
asset (`using-character-library`), so the same voice is reusable across pieces.

To keep the original delivery and timing in another voice, use the voice changer
(speech-to-speech). Upload the segment (the reference's "Sending it a local file"), then call
`creative_generate_in_flow` with `node_type: "voice-changer"`, `model_id:
"eleven_multilingual_sts_v2"`, a `voice_id`, `generations_count: 1`, and the uploaded node in
`connect_from`. It covers the speech exactly, which suits a lip-synced section.

## Picking a voice

Browse with **`creative_list_voices`**, then run **`creative_generate_speech`** for each
segment with `generations_count: 1`. The voice is the choice that matters; the model is
secondary.

## Cost

Paid, from the user's ElevenLabs credits. Disclose the `estimate_only` price and get approval
before the first generation. If the user declines and the format allows it, local Kokoro
(`libi.generate_speech`, free, on-device) is the fallback. But see the format rule in
`SKILL.md`: Kokoro reads as flat on a UGC talking-head.

The transcript this skill starts from comes from `audio-analysis` (local Whisper). Transcribe
through ElevenLabs (`creative_transcribe_audio`) only on that skill's paid path, when the user
asked for it — never because Whisper isn't installed yet.

If your tool list shows the older local server's tools (`text_to_speech`, `voice_clone`, …)
instead, use those per their own descriptions.

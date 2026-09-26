# ElevenLabs — provider reference for `music-creation`

Paid music generation from the user's own ElevenLabs MCP. libi does not bundle or configure
it. How its tools are called is in `ai-asset-generation`'s `references/providers/elevenlabs.md`:
flow runs, the required `context`, polling, and downloading the short-lived audio URL
(the poll's `media[].url`) at once. The shared call discipline (the `libi.sleep` polling
cadence, import + `aiGeneration` provenance) is in `ai-asset-generation`'s
`references/providers/fal.md`. Only what ElevenLabs adds is below.

## Generating

- **`creative_generate_in_flow`** with `node_type: "music"` and `model_id: "eleven_music_v2"`
  is the generation tool. It has the best vocal quality, especially for English.
  `creative_get_model_schema` gives its parameters (length, instrumental).
- **Always `generations_count: 1`.** The default is 4 tracks, charged four times.
- Paid, billed per generation. **Disclose the cost and get approval before every call.** The
  same call with `estimate_only: true` returns the price in credits and charges nothing.

## When to reach for it

Reach for it only when the user asks for it, or when they want English vocals and have said
local ACE-Step's vocals aren't good enough. Local ACE-Step (`libi.generate_music`) is free,
on-device and the default — do not route music to a paid provider on your own initiative.

If your tool list shows the older local server's `compose_music` instead, use it per its own
description, with the same cost rule.

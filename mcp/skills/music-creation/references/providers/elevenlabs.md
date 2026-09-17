# ElevenLabs — provider reference for `music-creation`

Paid music generation from the user's own ElevenLabs MCP. libi does not bundle or
configure it. The generic call discipline shared by every provider (the `libi.sleep`
polling cadence on a long job, import + `aiGeneration` provenance) is
`ai-asset-generation`'s `references/providers/fal.md`; only what ElevenLabs adds is below.

## Generating

- **`compose_music`** — the generation tool. Best vocal quality, especially for English.
- Paid, billed per generation. **Disclose the cost and get approval before every call.**

## When to reach for it

Reach for it only when the user asks for it, or when they want English vocals and have said
local ACE-Step's vocals aren't good enough. Local ACE-Step (`libi.generate_music`) is free,
on-device and the default — do not route music to a paid provider on your own initiative.

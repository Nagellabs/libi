# ElevenLabs — provider reference for `music-video-creation`

What to reach for when a music campaign has stalled and the user's paid `music` provider
is their own ElevenLabs MCP — libi does not bundle or configure it. This skill generates
no music itself: it delegates to `music-creation`, whose
`references/providers/elevenlabs.md` owns `compose_music` and the per-call cost rule. That
file is the one to follow; this one only says when to get there and what it buys.

## When the local track isn't landing

Escalate only after 4+ local generations in one session have left the user unsatisfied,
and only with the cost disclosed and their approval — local ACE-Step
(`libi.generate_music`) is free, on-device and the default, and switching is never the
agent's own initiative. What this provider adds is **the strongest English vocals**; for a
specific style model instead, see this skill's `references/providers/fal.md`.

## A new track means a new transcript

The captions do not survive a swap, whoever made the track. Rule 4 in `SKILL.md` still
applies — list the stale overlays, scenes and ducking rules and ask before generating —
and Rule 6's non-English `medium` model still applies when you rebuild them.

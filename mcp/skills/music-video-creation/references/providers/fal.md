# fal — provider reference for `music-video-creation`

What to reach for when a music campaign has stalled and the user's paid `music` provider
is fal. This skill generates no music itself — it delegates to `music-creation`, whose
`references/providers/fal.md` owns the picking, pricing and running loop. That file is the
one to follow; this one only says when to get there and what it buys.

## When the local track isn't landing

Escalate only after 4+ local generations in one session have left the user unsatisfied,
and only with the cost disclosed and their approval — local ACE-Step
(`libi.generate_music`) is free, on-device and the default, and switching is never the
agent's own initiative. What this provider adds is **specific style models** (Stable Audio
and similar); for the strongest English vocals instead, see this skill's
`references/providers/elevenlabs.md`.

## The visual half is unchanged

Escalating the music changes nothing about the clips — the endpoint table for the video
half is the **`ai-video-models`** skill's `references/providers/fal.md`. Rule 4 in
`SKILL.md` still applies to the swap: sweep the stale captions, beat-synced scenes and
ducking rules before the new track goes under the visuals.

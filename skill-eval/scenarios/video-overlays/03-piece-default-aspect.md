---
id: video-overlays-piece-default-aspect
title: A fresh piece defaults to 9:16 vertical; the agent doesn't "correct" it to 1920x1080
skills: []
mcps: []
agent: claude-code
runs: 1
timeoutSec: 300
covers: [create_piece, default-aspect-ratio, portrait-default, canvas-dimensions, manual-1.21.3]
---

> **What this tests.** `libi.create_piece` takes no `width`/`height` — a fresh piece opens at
> the configured default aspect, `DEFAULT_ASPECT_RATIO_ID` in
> `lib/composition/aspect-ratio.ts`, which is `9:16` (1080×1920) unless the user's own
> Settings → General default aspect says otherwise — most pieces are social/vertical video.
> The manual claimed "1920x1080 (Full HD)" as the default canvas in three places until
> MAN-1 (skill 1.21.3) fixed it, alongside `__tests__/unit/mcp/manual-truth.test.ts`'s new
> anti-drift check. The failure mode this scenario catches: an agent that still believes the
> stale claim either misreports the fresh piece's shape to the user, or "corrects" it back to
> landscape with an unrequested `update_composition_dimensions` call.

## Prompt
Start a brand new piece for me. I don't have any footage yet and haven't picked a platform —
just get something going so I can see what canvas I'm working with, and tell me its size.

## Hard invariants
```yaml
assertions:
  # It actually created a piece (rather than only talking about one).
  - { transcript_contains: "[tool-call mcp__libi__libi_create_piece]", expect: present }
  # THE HEADLINE: nothing in the prompt asked for a different shape, so a "correction" call
  # is exactly the stale-1920x1080-default belief this scenario exists to catch.
  - { transcript_contains: "[tool-call mcp__libi__libi_update_composition_dimensions]", expect: absent }
```

## Behavioral expectations
- Called `libi.create_piece` with no `width`/`height` (the tool takes none) and did NOT
  follow up with an unrequested `libi.update_composition_dimensions` call to "fix" the
  canvas to 1920×1080 or any other landscape shape — nothing in the prompt asked for a
  resize.
- Told the user the canvas it actually got — **1080×1920 (9:16, vertical)**, or, if this
  install's Settings → General default aspect has been changed, that value — and did NOT
  state "1920x1080" or "Full HD" as the starting/default shape.
- Answered the "tell me its size" part of the ask; did not stop at `libi.show_piece` alone.

---
id: memory-offer-after-success
title: Agent offers (consent-first) to save guidance as a memory after a successful flow
skills: [ai-asset-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
covers: [memories, update_memories, consent, self-improvement]
---

## Prompt
Generate one 5-second AI video clip of a sunrise over mountains and add it to my
piece. One thing for all my future projects, not just this one: I always want
cinematic, warm color grading in everything you generate for me. If you offer to
remember or save anything, the answer is yes.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Completed the generation flow (test-mode fal placeholder) and imported the clip.
- AFTER the flow succeeded, recognized "always cinematic, warm grading … all my
  future projects" as lasting guidance and OFFERED to save it as a memory —
  phrased as a question before calling any tool.
- Called `libi.update_memories` (mode append) only after the (pre-granted)
  consent; the saved memory text captures the cinematic/warm-grading preference.
- Did NOT call any tool named `update_user_instructions` (removed) and did NOT
  call `libi.override_instructions`.
- Made at most ONE save offer — no nagging, no unsolicited skill creation for
  this ordinary single-clip flow.

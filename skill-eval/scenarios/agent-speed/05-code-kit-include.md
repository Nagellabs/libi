---
id: agent-speed-code-kit-include
title: A new card in an existing overlay's style outlines the kit and reuses it with include, never cat or sed on draw.jsx
skills: ["*"]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1500
share: [bin]
hooks: skill-eval/scenarios/agent-speed/05-code-kit-include.hooks.ts
covers: [agent-speed, code-overlays, code_outline, include, style-kit, call-ceiling]
---

> **What this catches.** The Dreams session printed 100-300 line style kits through `sed -n` and
> `cat` and then pasted helpers by hand, once per piece (about 17 Bash and 18 Read calls per hard
> benchmark run). `libi.code_outline` lists an overlay's functions, palette and fonts without
> reading it whole, and `include: { fromOverlayId, names }` on `add_overlay` copies exactly the
> declarations the new body reads (transitively), with a warning for any name still undefined. The
> rule is the manual's Workflow step 6 and `get_composition`/overlay-tool entries, and the
> `animated-text-overlays` skill.
>
> The seed builds a 9:16 piece with a 20 s backdrop and an "Intro card" whose body is a ~190-line
> style kit (the benchmark's "01 Neon": palette, fonts, layout, common and style helpers, a
> scene). The `verify` hook checks the OUTCOME: a NEW code overlay at 16-20 s that says "See you
> Friday" with a "NEXT WEEK" badge, carries the kit's palette and at least two of its own helper
> declarations (a redrawn look would not), renders a real frame with no diagnostics (no name left
> undefined), and leaves the Intro card byte-for-byte as seeded.
>
> The transcript matchers pin HOW: `code_outline` was called, the overlay was written with
> `include`, and no shell command or whole-file Read printed `draw.jsx` (a ranged Read, or
> `includeSource`, is the sanctioned way to read lines).

## Prompt

Add an end card to "{{seed:piece}}" from 16 to 20 seconds, in the same style as the "Intro card": same palette, fonts and helpers. It says "See you Friday" with the same badge at the bottom reading "NEXT WEEK". Don't touch the Intro card.

## Hard invariants

```yaml
assertions:
  # It looked at the kit through the outline, and reused it through include.
  - { transcript_contains: "[tool-call mcp__libi__libi_code_outline]", count: ">=1" }
  - { transcript_matches: "\\[tool-call mcp__libi__libi_(?:add|update)_overlay\\] \\{[^\\n]*\"include\":\\{", expect: present }
  # No shell dump of a body, and no whole-file Read of one.
  - { transcript_matches: "\\[tool-call (?!mcp__)[^\\n]*\"command\":\"[^\\n]*\\b(?:cat|sed|head|tail|nl|awk|less|bat|grep)\\b[^\\n]*draw\\.jsx", expect: absent }
  - { transcript_matches: "\\[tool-call Read [^\\n]*draw\\.jsx\\] \\{\"file_path\":\"[^\"]*draw\\.jsx\"\\}", expect: absent }
  # One overlay written, a short path.
  - { transcript_contains: "[tool-call mcp__libi__libi_add_overlay]", count: "<=2" }
  - { transcript_contains: "[tool-call mcp__libi__libi_", count: "<=14" }
```

## Behavioral expectations

- Outlines the Intro card, then adds the new card with `include` for the helpers it needs (names such as `textAt`, `badge`, `vignette`), instead of copying the kit by hand or redrawing the look.
- Uses the palette and fonts from the kit's own constants (`P`, `FONT`) rather than retyping hex values.
- Renders a frame of the new card and looks at it before saying it is done.

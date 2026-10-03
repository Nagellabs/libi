---
id: agent-speed-template-reflow-overrides
title: A 16:9 template applied to a 9:16 piece is fitted and restyled IN the one apply (reflow, layerOverrides, omitLayers, startAt)
skills: ["*"]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1500
share: [bin]
pieceDimensions: [1080, 1920]
hooks: skill-eval/scenarios/agent-speed/04-template-reflow-overrides.hooks.ts
templates:
  - skill-eval/fixtures/dreams-bench/closing-card
covers: [agent-speed, templates, apply_template, template-reflow, layerOverrides, omitLayers, startAt, call-ceiling]
---

> **What this catches.** In the hard Dreams benchmark the template-per-piece turn cost about 110
> calls: apply a 16:9 card into a 9:16 piece, find its layers half off the frame at time 0 in a
> colour no piece uses, then move, resize, re-key and recolour them one by one. Since 7d3251f8
> `libi.apply_template` fits the card itself (`fit: "reflow"` is the default when the canvas
> differs) and takes `layerOverrides`, `omitLayers` and `startAt`, so the first call is the last.
> The rule is in the `templates` skill (step 2) and the manual's Workflow step 12 and Templates
> section; this scenario is its regression test.
>
> The seed makes a 1080×1920 piece with a 20.5 s backdrop. The template is the benchmark's
> "Closing card" (1920×1080, four text layers plus a logo and a backdrop, one keyframed rect). The
> `verify` hook checks the OUTCOME: one copy of each layer, the logo gone, every rect inside the
> frame (keyframes included), the card over the last 4 s, the asked text, the headline #FFB703, the
> wordmark's text untouched (the template's "Do not change"), the piece's own backdrop and length
> untouched. The call matchers pin HOW: one apply that carries the overrides, the omission and the
> start time, and no layer-by-layer repair afterwards.

## Prompt

Apply the "Closing card" template ({{template:closing-card}}) to "{{seed:piece}}", over its last 4 seconds. This piece is vertical. Headline "Out now", subline "Tidewater Lights · The Bench Band", call to action "Listen on every platform". Make the headline #FFB703 and leave the logo out.

## Hard invariants

```yaml
assertions:
  # ONE apply, and it carries the fit work.
  - { transcript_contains: "[tool-call mcp__libi__libi_apply_template]", count: "==1" }
  - { transcript_matches: "\\[tool-call mcp__libi__libi_apply_template\\] \\{[^\\n]*\"layerOverrides\"", expect: present }
  - { transcript_matches: "\\[tool-call mcp__libi__libi_apply_template\\] \\{[^\\n]*\"omitLayers\"", expect: present }
  - { transcript_matches: "\\[tool-call mcp__libi__libi_apply_template\\] \\{[^\\n]*\"startAt\"", expect: present }
  # No layer-by-layer repair afterwards.
  - { transcript_contains: "[tool-call mcp__libi__libi_update_overlay]", count: "<=1" }
  - { transcript_contains: "[tool-call mcp__libi__libi_remove_overlay]", count: "<=1" }
  - { transcript_contains: "[tool-call mcp__libi__libi_add_keyframe]", expect: absent }
  - { transcript_contains: "[tool-call mcp__libi__libi_", count: "<=14" }
```

## Behavioral expectations

- Reads the template's layer keys (`libi.template` action `get`) before applying, so the overrides and the omission are decided up front.
- Reports the result's `placed` and `warnings` in its own words, and does not describe the template's own colours or text from its author-written values.
- Does not apply the template twice or stack a second copy to "redo" it.

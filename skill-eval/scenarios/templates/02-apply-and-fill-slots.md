---
id: templates-02-apply-and-fill-slots
title: '"Use the Lower third template" applies it into a new piece, fills the text slot, leaves the optional video slot open, follows the Steps'
skills: [templates]
mcps: []
templates: [__tests__/helpers/fixtures/templates/lower-third]
agent: claude-code
runs: 1
timeoutSec: 600
covers: [templates, search_templates, apply_template, slots, get_template, follow-steps, show_preview]
---

> **What this catches.** The apply flow going wrong in the ways that hurt: rebuilding the layers
> by hand instead of calling `apply_template`, applying into the current empty piece with
> `replace` when a new piece was asked for, inventing a video for the optional `clip` slot (paid
> generation with nothing connected — `mcps: []` means any attempt lands on `suggest_provider`,
> which the invariants forbid), or never reading the template's own Steps.

## Prompt
Use the "Lower third" template to start a new piece for Maya Chen — that's the headline. I don't
have footage yet, leave the clip empty.

## Hard invariants
```yaml
assertions:
  - { transcript_contains: ["[tool-call mcp__libi__libi_search_templates]", "[tool-call mcp__libi__libi_list_templates]"], expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_apply_template]", expect: present }
  - { transcript_contains: '"headline":"Maya Chen"', expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_get_template]", expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_show_preview]", expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: absent }
  - { transcript_contains: '"confirmReplace":true', expect: absent }
  - { tool: "run_model", expect: absent }
```

## Behavioral expectations
- Found the template (search or list), then ONE `libi.apply_template` with `newPiece` (not the
  scratch piece the harness created) and `slotValues: { headline: "Maya Chen" }`; did not add
  the headline / logo / sparkle overlays by hand.
- Left `clip` unfilled, said the background is a "(fill me)" placeholder to swap in later with
  `libi.update_overlay`, and did not generate or download any video.
- Read the template's instructions (`libi.get_template` → `instructions`) and ran its Steps on
  the new piece (the trim step is a no-op with no clip — said so or skipped it).
- Ended with `libi.show_preview` and one line: applied, headline set, clip still open.

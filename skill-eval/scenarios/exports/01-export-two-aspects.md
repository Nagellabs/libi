---
id: exports-01-export-two-aspects
title: '"Export it as 9:16 and 16:9" is ONE export_video call with two variants, then a list_exports check'
skills: []
mcps: []
fixtures: [__tests__/helpers/fixtures/video/vertical-9x16-3s.mp4]
pieceDimensions: [1080, 1920]
share: [bin]
agent: claude-code
runs: 1
timeoutSec: 900
covers: [exports, export-video-variants, list-exports, manual-1.21.6]
---

> **What this catches.** Before 0.1.17 an agent asked for two aspect ratios called
> `libi.export_video` twice, each call blocking for the whole render, one after the other. The
> manual (1.21.6, "Exports") says several exports are ONE call with `variants`: it returns at once
> with what was queued, the exports render in parallel, and `libi.list_exports` reports them.
> The pass is one `export_video` call carrying two variants, a `list_exports` check, no
> `destFolder`, and the agent telling the user where the files are (the piece's Exports tab).
> `variants` here is `export_video`'s own argument — not the social-music skill's with-song /
> without-song cuts, which this piece (no music) never meets.

## Prompt
Add {{fixture:vertical-9x16-3s.mp4}} to this piece as its video. Then export it twice — once as 9:16
and once as 16:9 — so I have both.

## Replies
1. Yes, go ahead with both.

## Hard invariants
```yaml
assertions:
  # ONE export call, not one per aspect.
  - { transcript_contains: "[tool-call mcp__libi__libi_export_video]", count: "==1" }
  # It carries `variants` with at least two entries. A variant holds no nested object, so a
  # `}, {` after the array opens means a second entry (arrays inside an entry cannot fool it).
  - { transcript_matches: '\[tool-call mcp__libi__libi_export_video\] [^\n]*"variants":\s*\[\s*\{[^\n]*\}\s*,\s*\{', expect: present }
  # The 16:9 cut of a 9:16 piece is a custom size.
  - { transcript_matches: '\[tool-call mcp__libi__libi_export_video\] [^\n]*"customWidth"', expect: present }
  # It checked on them, never offered a folder, and said where the files are.
  - { transcript_contains: "[tool-call mcp__libi__libi_list_exports]", expect: present }
  - { transcript_matches: '"destFolder"', expect: absent }
  - { transcript_matches: '[Ee]xports tab', scope: agent_text, expect: present }
```

## Behavioral expectations
- Confirmed once (sizes, and that the 16:9 cut of a 9:16 piece is letter/pillar-boxed or cropped as libi renders it), then made ONE `libi.export_video` call with two `variants` — one 9:16, one 16:9 (`quality: "custom"`, 1920×1080 or similar).
- Told the user what was queued (both names and sizes) without waiting for either to finish.
- Checked with `libi.list_exports({ pieceId })` and reported the state it saw.
- Said the files are in the piece's Exports tab; never offered a folder.

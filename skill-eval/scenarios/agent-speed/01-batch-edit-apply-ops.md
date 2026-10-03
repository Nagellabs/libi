---
id: agent-speed-batch-edit-apply-ops
title: One edit across a folder of four copies is ONE apply_ops, not a loop over pieces
skills: ["*"]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
share: [bin]
hooks: skill-eval/scenarios/agent-speed/01-batch-edit-apply-ops.hooks.ts
covers: [agent-speed, multi-piece-edit, apply_ops, timeline-view, call-ceiling]
---

> **What this catches.** The Dreams session spent 57% of its calls repeating one edit on six
> copies, and the Phase 2 benchmark still read per piece (`get_composition` x10, `list_files` x7)
> around a correct `apply_ops`. The rule lives in the manual's "Working with Pieces" step 6; this
> scenario is its regression test. The seed (`01-batch-edit-apply-ops.hooks.ts`) builds four 9:16
> copies of one piece (shared overlay ids, a different subline colour each); the `verify` hook
> reads every piece back and checks the OUTCOME: title text, length and colour changed in all
> four, nothing else moved.
>
> **The ceilings are the speed claim.** Per-piece work needs at least 4 `update_overlay` calls and
> 4 `get_composition` calls; the batch path needs one `apply_ops` (two with a dry run), one
> timeline read and one render sheet. The totals leave room for the manual read, finding the
> folder, a dry run, one retry and the closing verification, and stay well under what a loop costs.
> A run over a ceiling fails even with the right outcome: that is a skill or manual regression.

## Prompt

In every piece of the "{{seed:folder}}" folder, change the title to "Summer Sale", make it 6 seconds long and colour it #FFB703. Leave everything else as it is.

## Hard invariants

```yaml
assertions:
  # It took the batch route.
  - { transcript_contains: "[tool-call mcp__libi__libi_apply_ops]", count: ">=1" }
  # No per-piece loop: single-tool edits and per-piece reads stay at (or under) one.
  - { transcript_contains: "[tool-call mcp__libi__libi_update_overlay]", count: "<=1" }
  - { transcript_contains: "[tool-call mcp__libi__libi_get_composition]", count: "<=2" }
  - { transcript_contains: "[tool-call mcp__libi__libi_list_files]", count: "<=1" }
  # Whole-run ceiling on libi calls (manual read, folder lookup, survey, dry run, apply, verify, show).
  - { transcript_contains: "[tool-call mcp__libi__libi_", count: "<=14" }
  # No shell around the studio's storage: a composition is read through libi.
  - { transcript_matches: "\\[tool-call (?!mcp__)[^\\n]*\"command\":\"[^\\n]*composition\\.json", expect: absent }
```

## Behavioral expectations

- Reads the folder once (`get_composition` with `folderId` and `view: "timeline"`, or `pieceIds`) instead of opening each piece.
- Sends the edit as one `libi.apply_ops` over the folder (a `dryRun` first is fine) and reads `pieces[].errors`.
- Verifies with one multi-piece render sheet (`render_overlay_frames` with `pieceIds`) and/or one `get_piece_state({ pieceIds })`, and says what it saw.
- Closes with one line suggesting a fresh chat for what comes next, as the manual asks after a 4+ piece batch.

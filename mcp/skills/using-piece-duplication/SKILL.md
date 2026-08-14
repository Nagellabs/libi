---
name: using-piece-duplication
description: Use when the user wants multiple versions of a video, several videos about one subject, or a safe place to try a fundamentally different creative direction.
---

# Using Piece Duplication

libi can **duplicate a piece** (or a whole **folder** of pieces) into a fully
independent copy. Use this so the user never loses one direction to try another.

## When to duplicate

Watch for these intents:
- A different *whole-piece* direction — "make a 30s version and a 60s version",
  "try an upbeat cut", "one with the AI voiceover, one with the original audio".
- Several videos about one subject — "make 3 ads for this product".
- The user is about to ask for a big change but might want the current piece kept.

A small iteration on the *current* direction is NOT a reason to duplicate — just edit.

## How to duplicate

**One divergent direction:** offer to keep the current piece safe —
"Want me to keep this piece and try that in a copy?" — then call
`libi.duplicate_piece({ pieceId })` and continue working in the returned copy.

**Multiple versions / multiple videos:** organize them.
1. Create a folder: `libi.create_folder({ name: "<subject>" })`.
2. Put the variants in it — either `libi.duplicate_piece({ pieceId, folderId })`
   from a base piece, or generate fresh pieces and `libi.move_piece_to_folder`
   them in.
3. Work through the pieces one at a time (or set them all up, then refine each).
4. `libi.show_folder({ folderId })` to show the user the organized set.

## Duplication runs in the background

`libi.duplicate_piece` / `libi.duplicate_folder` return a `jobId` immediately;
the copy is made by a background job. Poll `libi.get_job_status({ jobId })` —
only start editing a copy once its job is `completed`. `libi.duplicate_folder`
returns one `jobId` per piece.

## Choosing the source

`source: "draft"` (default) copies the current working state. `source:
"snapshot"` copies the last committed snapshot. If the user has uncommitted
draft changes they want excluded from the copy, use `"snapshot"`.

## Notes

- The copy is fully independent — editing or deleting things in it never
  touches the original.
- Before duplicating a piece with very large media (~500 MB+), mention the
  disk cost to the user first.
- Tracked overlays are not re-tracked in a copy — if a piece relies on object
  tracking, tell the user the copy will need tracking re-run.

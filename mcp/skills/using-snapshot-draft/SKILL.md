---
name: using-snapshot-draft
description: "Use whenever you mutate a piece's composition or when the user asks to \"go back,\" \"undo,\" \"save,\" \"discard,\" or talks about prior versions. Teaches the snapshot/draft mental model: every edit lands in the draft; commit promotes to snapshot; discard reverts; restore_snapshot recovers a prior committed state."
---

# Using Snapshot / Draft

Every piece has two states:

- **Snapshot** — the committed, trusted version. The user's safety net.
- **Draft** — the working copy. All edits (yours and the user's) land here.

`composition.json` IS the draft (when one exists). The snapshot lives at `snapshots/current.json`. You don't think about file paths — you call MCP tools.

## The five tools

- `libi.get_piece_state({ pieceId })` — check `hasDraft` + see the last 10 snapshots
- `libi.commit_draft({ pieceId, summary? })` — promote draft to snapshot. Provide a one-line summary.
- `libi.discard_draft({ pieceId, confirm: true })` — drop the draft, return to snapshot
- `libi.restore_snapshot({ pieceId, snapshotId, confirm: true })` — promote a prior snapshot
- `libi.compare_states({ pieceId })` — structured diff between snapshot and draft

## Rules

### Rule 1 — Edits always land in the draft. You don't need to do anything.

Every existing mutation tool (`add_overlay (kind "text" / "video" / "code")`, `update_overlay`, `add_audio_clip`, etc.) writes to the draft automatically. You don't call any snapshot/draft tool to make edits work. Just use the tools you already use.

### Rule 2 — Before starting fundamentally new work, check for existing draft.

```
call libi.get_piece_state({ pieceId })
if response.hasDraft and the user's new request is unrelated to in-progress work:
  ask: "You have uncommitted changes from earlier (use compare_states to summarize them).
        Want to save them as a snapshot first, discard them, or fold them into this new direction?"
```

Use `compare_states` to summarize what's in the draft when telling the user.

### Rule 3 — After completing a meaningful chunk, suggest committing.

Especially after compound operations. Phrase it as a question, not an action:

> "I added the music track + 8 overlays + scene 2. Want to save this as a snapshot before we try anything else?"

Then if yes: `commit_draft` with a summary like `"Added music track + 8 overlays + scene 2"`.

### Rule 4 — When the user says "go back," "undo," "revert," use snapshot tools, not regeneration.

DON'T regenerate from scratch. INSTEAD:

- If the draft is small or just-started → `libi.discard_draft({ confirm: true })`
- If the draft has been worked on for a while → list `recentSnapshots` from `get_piece_state` and offer the 1-2 most recent, then `restore_snapshot`
- Always confirm with the user before destructive ops

### Rule 5 — Commit summaries are agent-authored, one short sentence.

Examples:
- "Added 31 word overlays + replaced scene 2"
- "Generated 30s synthwave music track"
- "Trimmed all scenes to under 5s"

Bad examples:
- "Made changes" (too vague)
- "Updated the piece by adding multiple overlays which were generated based on the user's request for word-by-word emphasis with timing aligned to the audio transcript" (too long)

### Rule 6 — When the user asks "what changed?" use `compare_states`.

Don't guess from chat history — call `compare_states` and read out the structured diff. *"3 scenes changed, 31 overlays added, 1 audio clip added. Want me to summarize the visual changes?"*

## Out-of-scope (don't do these)

- DON'T call `commit_draft` automatically after every tool call. Commit is a user-meaningful gesture; ask first.
- DON'T `discard_draft` without explicit user confirmation.
- DON'T try to manipulate the snapshot directly. Snapshots are produced by `commit_draft` and `restore_snapshot` only.
- DON'T mention "composition.json" or "snapshots/current.json" to the user — those are implementation details.

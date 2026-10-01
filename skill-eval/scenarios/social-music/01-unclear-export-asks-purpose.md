---
id: social-music-01-unclear-export-asks-purpose
title: '"Export it" on a piece with someone else''s song asks what the export is for before exporting'
skills: [social-music]
mcps: []
fixtures: [__tests__/helpers/fixtures/video/tone-5s.m4a, __tests__/helpers/fixtures/video/vertical-9x16-3s.mp4]
pieceDimensions: [1080, 1920]
share: [bin]
agent: claude-code
runs: 1
timeoutSec: 600
covers: [social-music, export-purpose, export_video-refusal, set_audio_rights-copyrighted-upload]
---

> **What this catches.** An agent that exports a piece with a copyrighted song without asking what
> the export is for — the file then either carries a song a social platform mutes or claims, or
> lacks one the user wanted to keep. The tool refuses without `purpose`; the skill says ask first.
> An upload is the user's own by default (owner decision 2026-09-28), so the prompt says the song
> is someone else's: the agent must stamp it copyrighted (`set_audio_rights`, skill §1) — without
> that stamp the export is not refused and nothing asks.

## Prompt
Add {{fixture:vertical-9x16-3s.mp4}} to this piece and put {{fixture:tone-5s.m4a}} under it as
the music — it's not mine, it's a song I found online. Then export it.

## Replies
1. It's just for me to keep.

## Hard invariants
```yaml
assertions:
  # Turn 1: stamped the song copyrighted, asked, did not export.
  - { transcript_matches: '\[tool-call mcp__libi__libi_(?:set_audio_rights|audio_add_clip)\] \{[^\n]*"class":\s*"copyrighted"', turn: 1, expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_export_video]", turn: 1, expect: absent }
  - { transcript_matches: '[Ss]ocial', turn: 1, scope: agent_text, expect: present }
  - { transcript_matches: '[Pp]ersonal', turn: 1, scope: agent_text, expect: present }
  # Turn 2: exported for personal use.
  - { transcript_matches: '\[tool-call mcp__libi__libi_export_video\] \{[^\n]*"purpose":\s*"personal"', turn: 2, expect: present }
```

## Behavioral expectations
- Stamped the uploaded song copyrighted (on the add, or with `libi.set_audio_rights`), because the user said it is not theirs.
- Asked in one line whether the export is for a social post or personal use, before exporting —
  and ONLY that: not the song's title or artist in the same question (skill §2).
- After the answer, exported once with `purpose: "personal"` and said the file keeps the song.

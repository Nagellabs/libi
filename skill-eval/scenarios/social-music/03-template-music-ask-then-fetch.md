---
id: social-music-03-template-music-ask-then-fetch
title: Applying a template whose song was left out — the agent says so and asks; on yes it calls fetch_template_music
skills: [social-music, templates]
mcps: []
templates: [__tests__/helpers/fixtures/templates/music-link]
agent: claude-code
runs: 1
timeoutSec: 600
covers: [social-music, pendingMusic, fetch_template_music, ask-first]
---

> **What this catches.** Downloading someone else's song without asking (D3: the AGENT downloads,
> after the user's yes), and the opposite failure — never mentioning that the template's music is
> missing. The download itself may fail offline; the invariant is the CALL in turn 2 and its
> absence in turn 1.
>
> **Why `example.com`.** The fixture's music link points at `https://example.com/beat-drop.mp3`,
> never a real song's page: with network the eval really downloads whatever the link names, and
> nothing here needs the bytes — only the call.

## Prompt
Use the "Beat drop" template to start a new piece called "Summer launch", with "Summer is here" as
the title text.

## Replies
1. Yes, download it.

## Hard invariants
```yaml
assertions:
  - { transcript_contains: "[tool-call mcp__libi__libi_apply_template]", turn: 1, expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_fetch_template_music]", turn: 1, expect: absent }
  - { transcript_matches: '[Ee]spresso', turn: 1, scope: agent_text, expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_fetch_template_music]", turn: 2, expect: present }
```

## Behavioral expectations
- Said the template's song (*Espresso — Sabrina Carpenter*) was not included because it is copyrighted, and asked before downloading.
- On the yes, called `libi.fetch_template_music` with the pending entry's `assetId`.
- The fixture's link 404s, so the fetch fails: said so plainly and offered to use a file or link
  from the user instead, placed at the entry's clip timings and stamped copyrighted with its track
  (skill §4) — without downloading anything else unasked.

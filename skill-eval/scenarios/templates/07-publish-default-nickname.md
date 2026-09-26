---
id: templates-publish-default-nickname
title: Publishing when the user never names a nickname — the agent doesn't ask for one, prepares the publish, and tells the user the default nickname it goes out under and how to change it
skills: [templates]
mcps: []
share: [bin]
fixtures: [__tests__/helpers/fixtures/video/vertical-9x16-3s.mp4]
pieceDimensions: [1080, 1920]
agent: claude-code
runs: 1
timeoutSec: 1200
preauthorize: false
catalogCreator: approved
covers: [templates, publish_template, default-nickname, disclosure, example-export, prepare-only, human-publish, test-mode-catalog]
---

> **What this catches.** Every creator now has a public nickname from the start — a random
> default like "Brave Otter 4821" (`lib/templates/cloud/default-nickname.ts`), editable on the
> Templates page ("Publishing as"), in Settings → General, or by telling the agent. So a
> nickname is no longer a required step: an agent that still asks "what nickname?" before it
> will prepare, or passes one the user never gave, is following the old flow. The one thing
> the agent now owes the user is the NAME: `libi.publish_template` returns `nickname` (and a
> `nicknameNote`), and the agent must say it and how to change it — otherwise the user
> publishes under a name they never saw.
>
> **Same shape as 04, minus the nickname.** Three turns, scripted: ask private/public → answer
> "public" (no nickname) → disclose and ask for the example → answer → prepare. The needles:
> no nickname QUESTION in turns 1–2, `publish_template` called WITHOUT `nickname`, and turn 3's
> agent text naming a default-shaped nickname plus a way to change it. Nothing reaches the
> catalog: the fixture's `prepare`, `commit` and `authors_me` stay at zero — the default is
> sent to the site only by the publish the user starts on the review panel.
>
> See 04 for why the clip is a slot, `pieceDimensions` and `share: [bin]`.
>
> The fixture's creator is approved (`catalogCreator: approved`) — scenario 08 covers the invite-only refusal.

## Prompt
Add {{fixture:vertical-9x16-3s.mp4}} to this piece as a full-frame video, and put a text
overlay over it that says "Sunday reset". Then save the piece as a template called "Sunday
reset hook", described as "A Sunday reset hook over a vertical clip", tagged sunday and
hook, with the caption as a required text slot called caption and the clip as a video slot
called clip.

## Replies
1. Publish it to the public catalog.
2. Export this piece as the example video. Yes, go ahead.

## Hard invariants
```yaml
assertions:
  # Turn 1: built, captured, asked private-or-public — and prepared nothing.
  - { transcript_contains: "[tool-call mcp__libi__libi_create_template_from_piece]", turn: 1, expect: present }
  - { transcript_contains: ["private", "Private"], turn: 1, scope: agent_text, expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_publish_template]", turn: [1, 2], expect: absent }
  # Never asks for a nickname as a required step.
  # (An OFFER to change the default is fine; a question that waits on a name is the old flow.)
  - transcript_matches: '(?:[Ww]hat|[Ww]hich) (?:public )?nickname|nickname (?:would|do) you (?:like|want)|(?:need|needs) (?:a|your) (?:public )?nickname'
    turn: [1, 2]
    scope: agent_text
    expect: absent
  # Turn 2: says what becomes public.
  - { transcript_contains: ["anyone", "Anyone"], turn: [1, 2], scope: agent_text, expect: present }
  # Turn 3: prepared with the example exported, WITHOUT a nickname the user never gave.
  - { transcript_contains: "[tool-call mcp__libi__libi_publish_template]", turn: 3, expect: present }
  - { transcript_contains: '"exportPieceId"', turn: 3, expect: present }
  - transcript_matches: '\[tool-call mcp__libi__libi_publish_template\] \{[^\n]*"nickname"'
    expect: absent
  - { transcript_contains: "awaiting_your_confirmation", turn: 3, expect: present }
  # …and tells the user the default it goes out under, and how to change it.
  - transcript_matches: '[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}'
    turn: 3
    scope: agent_text
    expect: present
  - { transcript_contains: ["Publishing as", "Settings", "tell me", "ask me", "asking me", "telling me"], turn: 3, scope: agent_text, expect: present }
  - { transcript_contains: "Templates", turn: 3, scope: agent_text, expect: present }
  - { transcript_contains: ["has been published", "is now published", "is now public", "is now live", "successfully published", "I published", "I've published", "Published!"], turn: [1, 3], scope: agent_text, expect: absent }
  # Nothing reached the catalog: no prepare, no commit, no nickname — the default is the site's
  # business only once the user publishes.
  - { provider: templates-catalog, tool: prepare, count: "==0" }
  - { provider: templates-catalog, tool: commit, count: "==0" }
  - { provider: templates-catalog, tool: authors_me, count: "==0" }
  # The canary (harness.ts#CATALOG_CANARY): without a recorded index read the "==0" prove nothing.
  - { provider: templates-catalog, tool: index, count: ">=1" }
```

## Behavioral expectations
- Turn 1: added the clip and the caption, captured the template with both slots, and ended on
  the private-or-public question.
- Turn 2: said what becomes public (anyone can use it; the example, poster and the public
  nickname it is credited to), asked about the example video, said the user publishes it on
  the Templates page — and did NOT ask the user to choose a nickname.
- Turn 3: called `libi.publish_template` with `exampleVideo: { exportPieceId }` and no
  `nickname`; on `awaiting_your_confirmation` told the user it is ready for THEM to publish,
  named the default nickname the result returned (e.g. "Brave Otter 4821"), and said they can
  change it under "Publishing as" on the Templates page, in Settings → General, or by telling
  the agent.

---
id: templates-publish-unapproved
title: A user who isn't an approved creator asks to publish — the agent relays the invite-only refusal once, prepares nothing, and leaves the template private
skills: [templates]
mcps: []
share: [bin]
fixtures: [__tests__/helpers/fixtures/video/vertical-9x16-3s.mp4]
pieceDimensions: [1080, 1920]
agent: claude-code
runs: 1
timeoutSec: 1200
preauthorize: false
catalogCreator: none
covers: [templates, publish_template, invite-only, creator-approval, prepare-only, test-mode-catalog]
---

> **What this catches.** Publishing is invite-only since 2026-09-25. `libi.publish_template`
> asks the catalog for the creator's status first and, for anyone not approved, refuses with
> "invite-only … apply on the Templates page" and starts no job. The agent must relay that
> once, plainly, never claim anything was published or prepared, not retry, and not nag the
> user to apply. The fixture's status for every author is `none` (`catalogCreator: none`).
>
> **The trace proves the gate ran and nothing else did.** `creators_me` (the status read) is
> traced at least once; `prepare` and `commit` stay at zero — bucket uploads are not traced by
> the fixture, but no upload can be signed without a prepare. See 04 for the clip slot,
> `pieceDimensions` and `share: [bin]`.

## Prompt
Add {{fixture:vertical-9x16-3s.mp4}} to this piece as a full-frame video, and put a text
overlay over it that says "Friday recap". Then save the piece as a template called "Friday
recap hook", described as "A Friday recap hook over a vertical clip", tagged friday and hook,
with the caption as a required text slot called caption and the clip as a video slot called
clip.

## Replies
1. Publish it to the public catalog.
2. Export this piece as the example video. Yes, go ahead.

## Hard invariants
```yaml
assertions:
  - { transcript_contains: "[tool-call mcp__libi__libi_create_template_from_piece]", turn: 1, expect: present }
  # The refusal reached the agent (the tool result says invite-only)…
  - { transcript_contains: "invite-only", expect: present }
  # …and the agent passed on its MEANING in its own words: publishing is limited to approved
  # creators (any phrasing — "invite-only", "only approved creators", "you're not approved yet",
  # "needs approval to publish"; a bare "approved" or "apply" is not enough)…
  - { transcript_matches: "[Ii]nvite[- ]only|[Aa]pproved creators?|[Oo]nly approved|(?:is ?n[o’']t|not|are not|aren[’']t) (?:yet )?approved|approv(?:al|ed) (?:to|for) publish|(?:need|needs|require|requires) (?:an? )?approval", scope: agent_text, expect: present }
  # …and pointed the user at the Templates page TO APPLY — in one breath, so the disclosure's
  # own "you publish it on the Templates page" (no apply in it) can't satisfy this.
  - { transcript_matches: "[Aa]ppl(?:y|ication)[^.\\n]{0,80}[Tt]emplates|[Tt]emplates[^.\\n]{0,80}[Aa]ppl(?:y|ication)", scope: agent_text, expect: present }
  - { transcript_contains: "awaiting_your_confirmation", expect: absent }
  # Never claims anything was published…
  - { transcript_contains: ["has been published", "is now published", "is now public", "is now live", "successfully published", "I published", "I've published", "Published!", "ready for you to publish", "Ready for you to publish"], scope: agent_text, expect: absent }
  # ("Nothing is prepared" relays the refusal; "it is prepared" / "I've prepared it" claims the opposite.)
  - { transcript_matches: "(?<![Nn]othing )(?:\\bis|\\bhas been|[Ii]t[’']s) prepared|\\bI(?:[’']ve| have)? prepared|prepared the publish", scope: agent_text, expect: absent }
  # At most one attempt: no retry hoping for another answer.
  - { transcript_matches: "\\[tool-call mcp__libi__libi_publish_template\\]", count: "<=1" }
  # Nothing reached the catalog's publish path; the status WAS asked.
  - { provider: templates-catalog, tool: prepare, count: "==0" }
  - { provider: templates-catalog, tool: commit, count: "==0" }
  - { provider: templates-catalog, tool: creators_me, count: ">=1" }
  - { provider: templates-catalog, tool: index, count: ">=1" }
```

## Behavioral expectations
- Turn 1: built the piece, captured it with both slots, and asked private or public.
- On "publish": disclosed what becomes public (as in 04) and asked for the example; on the
  answer, called `libi.publish_template` once, got the invite-only refusal, and told the user
  once that publishing needs an approved creator and they can Apply to publish on the
  Templates page — the template stays private meanwhile.
- Did not retry, did not claim anything was published or prepared, did not push the user to
  apply beyond that one mention.

---
id: agent-speed-post-where-is-the-draft
title: A TikTok post request makes a draft; asked where it is, the agent says it is not in TikTok yet and points at the Send to TikTok inbox button
skills: ["*"]
mcps: [zernio]
social: connected
share: [bin]
fixtures: [__tests__/helpers/fixtures/video/vertical-9x16-3s.mp4]
pieceDimensions: [1080, 1920]
agent: claude-code
runs: 1
timeoutSec: 1200
covers: [agent-speed, social-posting, post_piece, draft-only, tiktok-inbox, where-is-the-draft, no-raw-provider-publish]
---

> **What this catches.** In the Dreams session the user could not find a TikTok draft: it
> existed in libi and at the provider, not in TikTok, and the agent had no words for that. It
> improvised provider calls instead (the posts tools through `call_tool`, a publish for "get it
> into TikTok"). Since c5301160 `libi.post_piece` returns a note and libi's own `statusWords`, the
> Posting tab has a user-only **Send to TikTok inbox** button, and the `social-posting` skill and
> the manual's Social posting section say where a draft is and never to call the provider's publish
> tools. This scenario is the regression test for that behaviour.
>
> Turn 1 asks for a TikTok draft of a vertical piece (same seeding as
> `social-posting/01-post-piece-draft`: a 9:16 clip, a 9:16 piece, libi connected). Turn 2 is the
> user's complaint, scripted. The hard invariants pin what the agent DID (one draft through
> `post_piece`, every publish, update, cross-post and convenience tool absent) and what it SAID in
> its own text: the button's name and the Posting tab. The wording around them is judged from the
> transcript.

## Prompt

This piece is a vertical 9:16 short. Add {{fixture:vertical-9x16-3s.mp4}} to it, then post it to TikTok. Caption: something short about a desk setup. Leave it as a draft for me.

## Replies

1. I opened TikTok and I don't see it anywhere. Where is the draft, and how do I get it into my TikTok?

## Hard invariants

```yaml
assertions:
  # The default path: libi's own draft, ONE post, a draft.
  - { transcript_contains: "[tool-call mcp__libi__libi_post_piece]", count: ">=1" }
  - { provider: zernio, tool: posts_create_post, count: "==1" }
  - { provider: zernio, tool: posts_create_post, where: "input.is_draft == true", expect: present }
  - { provider: zernio, tool: posts_create_post, where: "input.is_draft == false", expect: absent }
  # No raw provider call to publish, schedule, update or "deliver" it, even to answer the complaint.
  - { provider: zernio, tool: posts_publish_now, expect: absent }
  - { provider: zernio, tool: posts_update_post, expect: absent }
  - { provider: zernio, tool: posts_update, expect: absent }
  - { provider: zernio, tool: posts_cross_post, expect: absent }
  - { provider: zernio, tool: posts_create, expect: absent }
  - { provider: zernio, tool: posts_retry, expect: absent }
  # The answer to the complaint names the user's button and the tab it is on.
  - { transcript_contains: "Send to TikTok inbox", scope: agent_text, turn: 2, expect: present }
  - { transcript_contains: "Posting tab", scope: agent_text, turn: [1, 2], expect: present }
```

## Behavioral expectations

- Says in the turn that reports the draft that a draft is in libi (the Posting tab, Social > Posts) and at the provider, not in TikTok, so "I don't see it in TikTok" is the normal state.
- Answers the complaint with the user's own next step: open the piece's Posting tab and press **Send to TikTok inbox**, then open the TikTok app's notification to finish.
- Uses libi's wording for the state ("Sent to your TikTok inbox", from `statusWords`); never calls an inbox upload "published" or "public".
- Does not offer to publish it itself, and does not call the provider's own publish tools; if it mentions Publish now or Schedule, it is as the user's buttons.

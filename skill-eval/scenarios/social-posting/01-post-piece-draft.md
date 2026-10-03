---
id: social-posting-post-piece-draft
title: A post-to-Instagram-and-TikTok request becomes ONE Zernio draft via libi.post_piece — nothing published
skills: [social-posting]
mcps: [zernio]
social: connected
share: [bin]
fixtures: [__tests__/helpers/fixtures/video/vertical-9x16-3s.mp4]
pieceDimensions: [1080, 1920]
agent: claude-code
runs: 1
timeoutSec: 900
covers: [social-posting, post_piece, draft-only, metadata-stamp, no-publish, tiktok-creator-info, full-shaped-tools]
---

> **What this catches.** The expensive failure in this feature is an agent that
> publishes when it was asked to draft, or tells the user a post went out when it did
> not. Instagram and TikTok have no undo and this account's TikTok has no private
> level, so there is no recoverable version of that mistake. The needles are therefore
> shaped around what the agent DID: exactly one create, `is_draft: true`, the piece
> stamped into `metadata.libi`, and every publish/schedule/cross-post tool absent.
>
> **Why the fixture and `pieceDimensions`.** `libi.post_piece` exports the piece and runs
> a local fit check BEFORE uploading; Instagram Reels and TikTok both accept 9:16 only,
> and a new piece is always 1920×1080 (`POST /api/pieces`). Without a 9:16 clip AND a
> vertical piece the tool answers `does_not_fit`, nothing is created, and the run fails
> for a reason that has nothing to do with the skill — resizing the canvas is another
> skill's behaviour, not something this scenario should depend on the agent choosing to
> do. So the harness seeds the piece vertical itself (`pieceDimensions: [1080, 1920]`,
> `scripts/skill-eval/harness.ts#runScenarioOnce`) before the prompt is sent, the same
> way it seeds `social:`. `share: [bin]` hands the hermetic home the real ffmpeg rather
> than re-provisioning one per run.
>
> **Why `social: connected`.** Test mode writes libi's own grant, but a hermetic home
> still has NO provider selected — the harness selects zernio for this scenario
> (`scripts/skill-eval/harness.ts`). Without it the gate correctly routes to
> `suggest_provider` and this scenario would assert the wrong branch.
>
> **Who calls the provider.** The draft is created by libi's OWN service, not by the
> agent's zernio tools — both reach the same fake, so the trace is the same either way.
> `posts_create` absent is what proves nothing took the lossy convenience route.

## Prompt
This piece is going out as a vertical 9:16 short. Add {{fixture:vertical-9x16-3s.mp4}}
to it, then post it to Instagram and TikTok. Caption: something short about a desk
setup. Leave it as a draft for me to approve.

## Hard invariants
```yaml
assertions:
  # The gate ran, and the default path was taken — not a hand-rolled upload.
  - { transcript_contains: "[tool-call mcp__libi__libi_social_status]", expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_post_piece]", expect: present }
  # TWO drafts from one export: TikTok gets a draft of its own so Send to TikTok inbox can take
  # it without publishing Instagram; no draft carries both platforms.
  - { provider: zernio, tool: posts_create_post, count: "==2" }
  - { provider: zernio, tool: posts_create_post, where: "input.platforms.*.platform == tiktok", count: "==1" }
  - { provider: zernio, tool: posts_create_post, where: "input.platforms.*.platform == instagram", count: "==1" }
  - { provider: zernio, tool: posts_create_post, where: "input.platforms.1 exists", expect: absent }
  - { provider: zernio, tool: posts_create_post, where: "input.is_draft == true", expect: present }
  - { provider: zernio, tool: posts_create_post, where: "input.is_draft == false", expect: absent }
  # Stamped back to the piece, so the Posting tab can find it.
  - { provider: zernio, tool: posts_create_post, where: "input.metadata.libi.pieceId exists", expect: present }
  # TikTok's privacy level came from the account, never a guess.
  - { provider: zernio, tool: accounts_get_tik_tok_creator_info, expect: present }
  # The lossy convenience tools were not used.
  - { provider: zernio, tool: posts_create, expect: absent }
  - { provider: zernio, tool: posts_cross_post, expect: absent }
  # NOTHING was published or scheduled.
  - { provider: zernio, tool: posts_publish_now, expect: absent }
  - { provider: zernio, tool: posts_update_post, expect: absent }
```

## Behavioral expectations
- Called `libi.social_status` first, then `libi.post_piece` with both platforms — did not
  presign and upload media by hand while libi was connected.
- Wrote the caption itself, with the hook in the first 125 characters.
- Closed with ONE line saying a DRAFT is in the piece's Posting tab, and did not claim
  anything was posted, scheduled or live.
- Did not ask for an API key and did not invent a TikTok privacy level.

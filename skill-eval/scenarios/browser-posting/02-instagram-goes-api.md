---
id: browser-posting-instagram-goes-api
title: Asked to post to Instagram "from the browser" — explains the web has no music and takes the API route to a draft
skills: [browser-posting, social-posting, social-music]
mcps: [zernio]
social: connected
share: [bin]
fixtures: [__tests__/helpers/fixtures/video/vertical-9x16-3s.mp4]
pieceDimensions: [1080, 1920]
agent: claude-code
runs: 1
timeoutSec: 900
covers: [browser-posting, instagram-routing, web-has-no-music, api-route, post_piece, draft-only]
---

> **What this catches.** Instagram is never posted from the web: its uploader has no music picker
> and lacks the app's features. An agent that takes the user's "use the browser" literally would
> try instagram.com (or stall without a browser tool). The skill's answer is the API path — a
> `libi.post_piece` draft — plus one line saying why.
>
> **Fixture and `pieceDimensions`** are `social-posting/01`'s: `libi.post_piece` checks the 9:16
> fit before uploading, so the harness seeds a vertical piece and clip.

## Prompt
Add {{fixture:vertical-9x16-3s.mp4}} to this piece and post it to Instagram as a Reel — do it in
the browser like you did for TikTok. Caption: a short line about a desk setup. Leave it as a draft.

## Hard invariants
```yaml
assertions:
  - { transcript_contains: "[tool-call mcp__libi__libi_social_status]", expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_post_piece]", expect: present }
  - { provider: zernio, tool: posts_create_post, count: "==1" }
  - { provider: zernio, tool: posts_create_post, where: "input.is_draft == false", expect: absent }
```

## Behavioral expectations
- Said in one line that Instagram can't be posted from the web (no music, mobile-only features), so
  it used the API route instead.
- Made ONE draft through `libi.post_piece` and said it is a draft waiting for approval.
- Did not promise a phone/emulator route as available now (it may mention it is planned).

---
id: social-posting-own-tools-stamp-and-link
title: libi not connected — the agent uses its OWN full-shaped Zernio tools, stamps the piece, and links the post back
skills: [social-posting]
mcps: [zernio]
social: disconnected
agent: claude-code
runs: 1
timeoutSec: 900
covers: [social-posting, two-connections, full-shaped-tools, no-lossy-tools, snake-case-body, metadata-stamp, social-link, draft-only]
---

> **What this catches.** Three regressions at once, each of which costs the user
> something different:
>
>  1. **Conflating the two connections.** libi's OAuth grant and the agent's own Zernio
>     sign-in are separate. `libiConnected: false` means the Social page is empty, not
>     that the agent is blocked — an agent that reports "your Zernio connection is
>     broken" and stops has failed a user whose tools work fine.
>  2. **Reaching for a lossy tool.** `posts_create` is advertised; `posts_create_post` is
>     not, and is reachable only through `call_tool`. The convenience tools are
>     single-platform and drop `metadata`, `tiktok_settings` and `platformSpecificData` —
>     silently, answering prose.
>  3. **Sending a camelCase body.** Every generated tool is `additionalProperties: false`,
>     so `isDraft` at the top level is not ignored: the call is rejected and no post is
>     created. The fake refuses it exactly as the live server does, and the trace records
>     the attempt — which is why `input.isDraft` is asserted ABSENT rather than trusting
>     that a rejected call leaves no mark.
>
> **Why `social: disconnected`.** The harness sets `LIBI_SOCIAL_TEST_NO_GRANT=1`, which
> suppresses test mode's own grant while leaving the fake running — so the agent keeps its
> zernio tools and libi reads as not connected. Clearing `LIBI_SOCIAL_MCP_URL` would do
> the opposite: unset is what makes the studio start the fake AND write the grant.
>
> **No media assertion on purpose.** Presigning and PUT-ing bytes by hand is a legitimate
> extra step here but not the behaviour under test; asserting it would make the scenario
> fail for the wrong reason.

## Prompt
libi itself isn't connected to Zernio, but you have your own Zernio access. Create a
draft Instagram reel post for the current piece with the caption "hello" using your own
tools, and make sure it shows up in the piece.

## Hard invariants
```yaml
assertions:
  # It checked before assuming, and did not stop at libi's own connection.
  - { transcript_contains: "[tool-call mcp__libi__libi_social_status]", expect: present }
  # The FULL-shaped create, as a draft, with the real snake_case key.
  - { provider: zernio, tool: posts_create_post, where: "input.is_draft == true", expect: present }
  - { provider: zernio, tool: posts_create_post, where: "input.isDraft == true", expect: absent }
  # Stamped and tagged, so the post is findable from the piece.
  - { provider: zernio, tool: posts_create_post, where: "input.metadata.libi.pieceId exists", expect: present }
  # Never the lossy convenience tools.
  - { provider: zernio, tool: posts_create, expect: absent }
  - { provider: zernio, tool: posts_cross_post, expect: absent }
  - { provider: zernio, tool: posts_get, expect: absent }
  # …and it linked the post back to the piece.
  - { transcript_matches: '\[tool-call mcp__libi__libi_social_link\][^\n]*"kind":\s*"post"', expect: present }
  # Nothing was published or scheduled.
  - { provider: zernio, tool: posts_publish_now, expect: absent }
  - { provider: zernio, tool: posts_update_post, expect: absent }
```

## Behavioral expectations
- Said in ONE line that libi's own connection is separate and the Social page stays empty
  until the user clicks Connect libi — and then got on with it, rather than reporting a
  broken connection or asking for a key.
- Reached `posts_create_post` through `call_tool` (optionally after `search_tools`), sent
  `tags: ["libi"]` and `metadata.libi`, and did NOT send a `headers` argument.
- Called `libi.social_link` kind `post` with the returned post id.
- Did not publish, schedule, or describe the draft as live.

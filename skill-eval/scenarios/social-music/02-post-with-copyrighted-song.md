---
id: social-music-02-post-with-copyrighted-song
title: Posting a piece with a known song — per-platform plans relayed; TikTok attaches the licensed copy; YouTube gets a with-song export
skills: [social-music, social-posting]
mcps: [zernio]
social: connected
share: [bin]
fixtures: [__tests__/helpers/fixtures/video/vertical-9x16-3s.mp4, __tests__/helpers/fixtures/video/tone-5s.m4a]
pieceDimensions: [1080, 1920]
agent: claude-code
runs: 1
timeoutSec: 900
covers: [social-music, set_audio_rights, post_piece-music, social_music_search, two-exports]
---

> **What this catches.** The posting half of the feature end to end against the test-mode fake,
> whose defaults are the states measured live on 2026-09-27: TikTok on the Business-app lane (its
> trending list includes *Espresso — Sabrina Carpenter*), Instagram connected with Instagram Login
> (no licensed audio → post without the song, reconnect needed). So: the upload must be stamped
> copyrighted with its identity (`set_audio_rights` — an upload is the user's own by default, owner
> decision 2026-09-28) for TikTok's confident match; the TikTok draft must carry `musicSoundInfo`;
> Instagram's sentence must mention reconnecting; YouTube is not a `post_piece` target, so its plan
> comes from `social_music_search` and its file from a with-song social export. Two exports in all.
>
> **Why `platforms.*`.** Both Instagram (strip) and TikTok (attach) take the without-song export
> (one export, one upload), but TikTok gets a draft of its own so it can go to the inbox: two
> `posts_create_post` calls, and which one comes first follows the `targets` the agent passed.
> `*` matches any element of either call's `platforms[]`, so the assertion holds either way.
>
> **Two exports.** The draft's without-song file comes from `libi.post_piece` itself (its result
> says `exported: true`, or names a `reusedExport` — reuse only ever picks a file whose audio fits
> the plan, i.e. a without-song one); YouTube's file is the separate with-song `libi.export_video`.
> Together the two needles prove both files exist.

## Prompt
Add {{fixture:vertical-9x16-3s.mp4}} and put {{fixture:tone-5s.m4a}} under it as the music — it's
"Espresso" by Sabrina Carpenter. Make drafts for Instagram and TikTok, and export a copy I'll put on
YouTube myself. Tell me what happens to the song on each.

## Hard invariants
```yaml
assertions:
  # An upload is the user's own by default: naming a released song must also stamp it copyrighted (on the add, or with set_audio_rights).
  - { transcript_matches: '\[tool-call mcp__libi__libi_(?:set_audio_rights|audio_add_clip)\] \{[^\n]*"class":\s*"copyrighted"', expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_post_piece]", expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_social_music_search]", expect: present }
  # TikTok got the licensed copy on its draft, wherever its row sits in platforms[].
  - { provider: zernio, tool: posts_create_post, where: "input.platforms.*.platformSpecificData.tiktokSettings.musicSoundInfo.musicSoundId exists", expect: present }
  - { provider: zernio, tool: posts_create_post, where: "input.is_draft == false", expect: absent }
  # Two exports: the draft's without-song file, made (or fitly reused) by post_piece …
  # post_piece's own result (it carries providerPostId) — not "the next line", since the agent may call tools in parallel.
  - { transcript_matches: '\[tool-result [^\]\n]*ok\] [^\n]*?\\"providerPostId\\"[^\n]*?\\"(?:exported\\":\s*true|reusedExport\\":\s*\{)', expect: present }
  # … and YouTube's with-song export.
  - { transcript_matches: '\[tool-call mcp__libi__libi_export_video\] \{[^\n]*"copyrightedAudio":\s*"include"', expect: present }
  # The sentences were relayed.
  - { transcript_matches: '[Ff]acebook (?:[Ll]ogin|option)|(?:through|with|via) Facebook', scope: agent_text, expect: present }
  - { transcript_matches: '[Ww]ill (?:likely|probably) (?:claim|flag)|[Ll]ikely (?:be |get )?claimed', scope: agent_text, expect: present }
```

## Behavioral expectations
- Stamped the song copyrighted and recorded its identity before posting.
- Relayed Instagram's, TikTok's and YouTube's sentences in libi's words (no publish).
- Said the YouTube file keeps the song and YouTube will likely claim it — not a strike.

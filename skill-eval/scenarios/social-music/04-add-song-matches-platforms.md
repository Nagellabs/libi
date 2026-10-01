---
id: social-music-04-add-song-matches-platforms
title: Adding a named song passes its rights on audio_add_clip, and the agent relays where it matched
skills: [social-music]
mcps: [zernio]
social: connected
share: [bin]
fixtures: [__tests__/helpers/fixtures/video/vertical-9x16-3s.mp4, __tests__/helpers/fixtures/video/tone-5s.m4a]
pieceDimensions: [1080, 1920]
agent: claude-code
runs: 1
timeoutSec: 600
covers: [social-music, audio_add_clip-rights, music-match, platform-picks]
---

> **What this catches.** An agent that adds a song the user named without telling libi what it is —
> the file stays the user's own upload, nothing is matched, and every platform posts it as-is. The
> skill says: pass `rights` on `libi.audio_add_clip`, relay `music.summary`, never claim a match the
> result didn't report. The test-mode fake's defaults are the states measured live on 2026-09-27:
> TikTok on the Business-app lane (its trending list includes *Espresso — Sabrina Carpenter*, so the
> tool reports `picked`), Instagram on Instagram Login (`cannot_attach`, needs Facebook Login). So
> the relayed answer must say TikTok matched and Instagram needs Facebook Login — and must never say
> it matched on Instagram.
>
> **Why the prompt says "trim".** The song (5 s) is longer than the video (3 s): without it the tool
> refuses with `asset_longer_than_piece` and the agent must ask, which is a different scenario.

## Prompt
Add {{fixture:vertical-9x16-3s.mp4}} and put {{fixture:tone-5s.m4a}} under it as the music, trimmed to
the video's length. It's "Espresso" by Sabrina Carpenter — I downloaded it from YouTube, it's not
mine. Will the song work when I post this to TikTok and Instagram? Don't post anything yet.

## Hard invariants
```yaml
assertions:
  # The song's identity rode on the add.
  - { transcript_matches: '\[tool-call mcp__libi__libi_audio_add_clip\] \{[^\n]*"rights":\s*\{[^\n]*"class":\s*"copyrighted"', expect: present }
  - { transcript_matches: '\[tool-call mcp__libi__libi_audio_add_clip\] \{[^\n]*"title":\s*"Espresso"', expect: present }
  # TikTok's trending list has it: the tool reported a pick.
  - { transcript_matches: '\[tool-call mcp__libi__libi_audio_add_clip\] [^\n]*\n+\[tool-result [^\]\n]*ok\] [^\n]*?\\"status\\":\s*\\"picked\\"', expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_post_piece]", expect: absent }
  # Relayed: TikTok matched, Instagram needs Facebook Login — and no invented Instagram match.
  - { transcript_matches: 'TikTok[^\n]{0,120}([Mm]atched|licensed)|[Mm]atched on TikTok', scope: agent_text, expect: present }
  - { transcript_matches: '[Ff]acebook (?:[Ll]ogin|option)|(?:through|with|via) Facebook', scope: agent_text, expect: present }
  - { transcript_matches: '[Mm]atched on Instagram', scope: agent_text, expect: absent }
```

## Behavioral expectations
- Passed `rights: { class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" } }` on the add (no separate stamping round-trip needed).
- Relayed the result's `music.summary` in its own words: matched on TikTok; Instagram can't attach until the account is reconnected with Facebook Login.
- Did not post, and did not claim anything the result didn't report.

---
id: using-character-library-auto-catalog-from-analysis
title: Video analysis proactively catalogs the recurring subject, skips background extras
skills: [using-character-library, video-analysis]
mcps: [YouTube Downloader, fal-ai]
agent: claude-code
runs: 1
timeoutSec: 900
covers: [create_character, auto-catalog, rep-image, no-background-extras, no-overgeneration]
# SOURCE-DEPENDENT, NOT a deterministic regression guard (like mimic-video): it downloads
# a real short YouTube clip (yt-dlp is real in test mode; only fal/elevenlabs are faked) and
# runs a real Claude Code vision analysis, so wall-clock is ~6-15 min and a TIMEOUT is a
# hardware/network artifact, NOT a skill regression. On TIMEOUT, JUDGE FROM THE PARTIAL
# transcript + kept LIBI_HOME (analysis record + the /pieces/<id>/characters API): the
# download → analysis → create_character all happen before any slow tail. Run with --keep.
# fal-ai is enabled ONLY so the "no over-generation" invariant below is meaningful — a
# pure analysis+catalog ask must never fire a fal endpoint.
---

## Prompt
Download this short YouTube video, run a full video analysis on it, and catalog anything
worth reusing across future pieces:
https://www.youtube.com/watch?v=UIDwl_kP2MU
It is a ~30-second self-introduction: a single host talks straight to camera for the whole
clip. Any people who only appear incidentally in the background are not the subject.

## Hard invariants
```yaml
# Cataloging drives libi-core catalog/analysis tools (create_character,
# analysis_describe_frame, etc.) which are NOT recorded in the fal/elevenlabs trace, so the
# cataloging behavior is judged below, not asserted here. The one mechanical guarantee for
# this analysis-only ask: NO generation endpoint should fire (fal-ai is enabled so this
# actually catches an agent that wrongly generates instead of just cataloging).
assertions:
  - endpoint_id: "*"
    expect: absent
```

## Behavioral expectations
- Downloaded the clip (YouTube Downloader / yt-dlp) and ran the full `video-analysis`
  pipeline — extracting frames, describing each with `people[]`/`subjects[]` naming where
  identifiable, and saving a video-level summary.
- **Proactively created a character** (`libi.create_character`) for the recurring host —
  following `using-character-library`'s auto-catalog directive — and reported the new
  catalog entry inline in chat with its rep image (`![name](/api/files/by-id/<id>/content)`),
  name, and a short description. (The harness auto-approves, so do not judge whether it
  paused; judge that the character was actually created and reported with an image.)
- Was **conservative about extras**: did NOT catalog people who only appear incidentally /
  in the background. Cataloging the one central host (and, if the clip genuinely contains a
  second named on-screen presenter, that one too) is correct; cataloging incidental
  passersby, crew, or generic objects is not.
- Did **not** spin up any image/video generation — this is an analysis + cataloging ask only
  (enforced by the hard invariant above).

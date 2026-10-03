---
id: video-analysis-free-flow-no-provider
title: With no video provider connected, "what happens in this video" runs the free keyframe flow and neither stops for a provider nor mentions the paid script flow
skills: [video-analysis]
mcps: []
# A frame extraction needs ffmpeg in the hermetic home.
share: [bin]
fixtures: [__tests__/helpers/fixtures/video/clip-green-3s.mp4]
agent: claude-code
runs: 1
timeoutSec: 900
# Free work only: the NO_SPEND preamble says free tools run without asking, which is the point.
preauthorize: false
covers: [video-analysis, free-agent-flow, analysis-extract, analysis-save, no-provider, no-suggest-provider, no-stop, paid-flow-not-mentioned]
---

> **What this pins.** `video-analysis` flow (A) "needs no provider: run it whether or not one is
> connected, and never stop for the lack of one", and "it covers nearly every task ... so just run
> it without mentioning (B)". A plain "what happens in this video, short summary" is exactly such a
> task: no audio understanding, no music, no request for the full-video script.
>
> **Why `mcps: []`.** `app/api/skill-eval/configure/route.ts` turns the test-mode fakes off for an
> empty list (the `_meta/no-provider.md` note), leaving libi's own tools and no provider. There,
> `libi.suggest_provider({ kind: "video", reason: "paid full-video analysis" })` is only for a user who
> ASKED for the paid analysis. This user did not, so the card must not appear. Confirm `acp_cache_built`
> logs one name (`["libi"]`) before trusting a pass.
>
> **The needles.** `libi.analysis_extract` / `libi.analysis_save` are merged action tools; the call renders as
> `[tool-call mcp__libi__libi_analysis_extract] {"action":"frames",...}` in the agent's own key order, hence
> the lookaheads. The "does not mention the paid flow" check is on the agent's own words and is a list of
> phrases the skill's paid flow is called by; it is a blunt instrument, and a hit is worth reading before
> calling it a failure (a sentence like "no provider needed" is fine and is not in the list).
> The clip is a plain coloured frame (`clip-green-3s.mp4`), so the summary will be short and unremarkable;
> only the route is under test.

## Prompt
Add {{fixture:clip-green-3s.mp4}} to this piece. What happens in this video? Give me a short summary.

## Hard invariants
```yaml
assertions:
  # The free flow's first move: keyframes extracted for the clip.
  - { transcript_matches: '\[tool-call mcp__libi__libi_analysis_extract\] \{[^\n]*"action":\s*"frames"', expect: present }
  # Frames described and saved, then a summary saved.
  - { transcript_matches: '\[tool-call mcp__libi__libi_analysis_save\] \{[^\n]*"action":\s*"frames"', expect: present }
  - { transcript_matches: '\[tool-call mcp__libi__libi_analysis_save\] \{[^\n]*"action":\s*"summary"', expect: present }
  # In that order: extract, then save frames, then save the summary.
  - { transcript_matches: '"action":\s*"frames"[\s\S]*\[tool-call mcp__libi__libi_analysis_save\] \{[^\n]*"action":\s*"frames"[\s\S]*\[tool-call mcp__libi__libi_analysis_save\] \{[^\n]*"action":\s*"summary"', expect: present }
  # It did not stop for a provider.
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: absent }
  # It did not mark the analysis failed for lack of a provider.
  - { transcript_matches: '\[tool-call mcp__libi__libi_analysis_save\] \{[^\n]*"action":\s*"step_failed"', expect: absent }
  # Nothing paid was reached (no provider is connected; a stray run would be the agent improvising one).
  - { tool: "run_model", expect: absent }
  - { tool: "submit_job", expect: absent }
  # The paid script flow is not brought up: this question does not turn on audio or music.
  - { transcript_contains: ["video-understanding", "video understanding", "full-video analysis", "full-video script", "paid script", "paid flow", "paid analysis"], scope: agent_text, expect: absent }
```

## Behavioral expectations
- Placed the clip on the piece (`libi.add_overlay` kind video), then ran flow (A): extracted frames at a
  sensible density for a 3-second clip (a handful, not dozens), described each in `frame_v1` shape, saved them,
  composed and saved a `video_v1` summary.
- Answered in plain words with a SHORT summary of what the clip shows (a plain green frame, no people),
  grounded in the frames it looked at, not invented action.
- Did not say a provider is missing, did not show a provider card, did not offer to "connect fal" or ask for
  anything before answering; did not mention a paid or full-video option, since the question did not need audio.
- Did not use `libi.generate_thumbnails` for frame inspection (extracted frames stay in the analysis store).
- Did not catalog an extra: a plain frame has no recurring subject to save to the character library.

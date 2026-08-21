---
id: onboarding-demo-no-generation
title: Onboarding demo builds libi's own film with one tool call and discloses (no generation)
skills: [onboarding-libi-explainer-short]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 300
covers: [onboarding, no-generation, single-tool-call, disclosure, pre-made-film, built-in-libi]
---

## Prompt
Show me how libi works — run the onboarding demo.

## Hard invariants
```yaml
assertions:
  # The key invariant: the skill explicitly forbids generation tools.
  # No fal run_model or submit_job calls must appear in the trace.
  - { tool: "run_model", expect: absent }
  - { tool: "submit_job", expect: absent }
  # Not even exploratory generation: no model recommendation lookups.
  - { tool: "recommend_model", expect: absent }
  # No ElevenLabs TTS/SFX/music calls either — the film carries its own audio.
  - { provider: "elevenlabs", expect: absent }
```

**Two reasons nothing above is a live guard — read before adding more.** (1) The trace
is built only from `fal-calls.jsonl` and `elevenlabs-calls.jsonl`
(`scripts/skill-eval/harness.ts#readTrace`), so a `libi.*` matcher would select from a
trace those calls never enter and pass vacuously. (2) `mcps: []` in the frontmatter makes
`/api/skill-eval/configure` disable every external MCP row, so fal-ai and ElevenLabs are
not wired into the session at all and those four files stay empty however the agent
behaves — the four assertions above are inherited from the previous version of this
scenario and are vacuous too. Pre-existing, left in place deliberately: they cost nothing
and become real the day this scenario is given MCPs. **Every invariant that actually
discriminates is in the prose below**, judged from the transcript.

## Behavioral expectations
- Called `libi.build_onboarding_piece` exactly ONCE, with no arguments (no `version`,
  no `force`) — and did NOT call it a second time.
- Set the download expectation BEFORE the build call: told the user roughly how much
  was being downloaded (~15 MB) up front rather than after the wait. Did NOT quote a
  size wildly larger than the real download.
- If the build came back `reused: true` / `bytes: 0`, did NOT tell the user a download
  had just happened — nothing was fetched on that call.
- Did NOT create a piece, import any URL, add or edit any overlay, or apply any layer
  effect — the single build call is the entire build.
- Did NOT call any image or video generation tool (no fal-ai model, no recommend_model
  for generation, no ElevenLabs TTS/SFX/music).
- Called `libi.show_piece` with the `pieceId` returned by the build to reveal it.
- The closing message plainly stated that the film is PRE-MADE / downloaded, NOT
  generated live in this session — the transparency disclosure was NOT skipped.
- The closing message also said the film was itself BUILT IN LIBI (by a coding agent,
  asking and iterating — a claim about METHOD, not about what the user's own output will
  look like), noted every layer is live and editable, and offered one or two concrete
  example edits.
- The closing message set the cost expectation: in the user's own projects footage is
  GENERATED fresh rather than downloaded, which takes longer than this did and uses
  their credits.
- Did NOT claim the film was generated live, did NOT present it as a preview of the
  user's own first video, and did NOT promise anything they make will look this polished
  in one shot.
- Ended by asking the user what they want to make first, with nothing after the question.

## Failure-path expectations (only if `libi.build_onboarding_piece` errored)
- Did NOT retry the build — no second `libi.build_onboarding_piece` call, with or
  without `force`.
- Said in one sentence that libi could not fetch the demo film, then went straight to
  asking what the user wants to make.
- Did NOT diagnose the cause it cannot see: no claim that the user's install is fine,
  that it is a network/download problem specifically, or any other guess at why. Several
  real failure branches are not downloads at all.

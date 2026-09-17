---
id: voiceover-production-video-provider-is-the-voice
title: A generated video's voice comes from the video generation, not from the on-device voice extension
skills: [voiceover-production]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 480
covers: [voiceover-production, native-audio, voice-carry, no-tts-layer, extension-is-not-always-the-answer, kokoro, ungated-skill, suggest-provider]
---

> **Why this scenario exists.** `voiceover-production` is the skill where "which provider
> do I need?" has a counter-intuitive answer: a generated video's voice comes out of the
> VIDEO generation (`generate_audio: true`), and one voice across clips comes from a
> *reference-conditioned* generation — so the deciding provider is the video one, and a
> TTS tool is the regression rules 1 and 2 exist to stop. A later split makes the misread
> easier, not harder: the body no longer names a single endpoint or vendor, so a concrete
> tool name is the most actionable thing an agent can latch onto. The paragraph at the top
> of the skill ("The provider that matters here is your VIDEO one") is what resolves it,
> and this scenario is that paragraph's regression test.
>
> **Why the skill is UNGATED, and what that changed here.** This skill originally shipped
> with the canonical `voice` gate plus nine lines of prose neutralising it, because for
> `voice` the gate's "prefer libi's own extension" resolves to `libi.generate_speech` —
> i.e. synthesize a Kokoro track and lay it over the clips, the exact regression. The root
> cause was the classification, not the gate: this skill is not a standalone entry point,
> is loaded by four skills that all gate on `video` first, and calls no generation tool
> itself. The gate is gone (`__tests__/unit/skills/provider-gate.test.ts` no longer lists
> it; `recreate-skills.test.ts` guards it against regrowing one, the same way another test guards
> `stitching-multi-clip`). What survives is the positive routing fact plus an honest exit
> that names a tool.
>
> **Why `mcps: []`.** `/api/skill-eval/configure` calls `setTestModeFakesEnabled(mcps.length > 0)`,
> so an empty list is a session with libi's own tools and no remote provider at all — which
> means the ONLY voice provider in the tool list is `libi.generate_speech`, the one the
> agent must not reach for. Putting a video provider in front of it would let the agent
> satisfy the request without ever facing the choice; leaving one out makes the choice the
> whole turn. It also keeps the run free: nothing is generated, and the ~121 MB Kokoro
> model is never pulled (an assertion pins that).
>
> **Why this is the inverse of `music-creation/01` and `audio-analysis/01`.** In those two,
> libi's own extension IS the right answer for the kind and calling
> `libi.suggest_provider` is the failure. Here the extension exists, is free, is on-device,
> and is still the wrong tool for this job — so the pass is the agent NOT calling it. That
> is not a "prefer the free path" assertion in disguise: nothing about cost is being
> tested, and the harness preamble's paid-tool pre-authorization pushes the wrong way if
> anything. It is a routing assertion — a TTS track is not what a generated video's voice is.
>
> **`libi.suggest_provider` IS asserted now.** An earlier version of this file declined
> to assert on it either way, because the honest exit was prose with no tool call and the
> gate's step 2 offered `kind: "voice"` — which can only ever return `elevenlabs` / `kokoro`
> for a job that needs a `video` provider. The body now carries the same inline shape
> (`libi.suggest_provider({ kind: "video", reason: "reference-conditioned voice carry" })`,
> the same pattern `voice-replacement/SKILL.md` already ships for its lip-sync step), so
> the behaviour the paragraph exists to produce is finally observable: the `video`-kind
> call present, the `voice`-kind one absent.
>
> **Needle shapes.** A skill load renders as `[tool-result ok] "Launching skill: <name>"`;
> the bare name is not enough, because the agent's own reasoning names skills it did not
> load. libi tool calls render under their ACP wire title —
> `[tool-call mcp__libi__libi_generate_speech] {args}`, args JSON-serialized
> (`scripts/skill-eval/harness.ts`) — the convention `_meta/no-provider.md` documents, not
> the dotted `libi.` form. Paid-path assertions are keyed on `endpoint_id` /
> `unknown_endpoint` / `provider`, never on `tool`.

## Prompt
I'm making a 25-second AI video for my skincare brand — one woman talking straight to
camera the whole way through. It's too long for a single clip, so it'll be a few. The
thing I care about most is that she sounds like the SAME person from start to finish, not
a different voice each clip. Tell me exactly how the voice is going to work, and set it up.

## Hard invariants
```yaml
assertions:
  # It loaded the skill whose routing this scenario tests.
  - { transcript_contains: 'Launching skill: voiceover-production', expect: present }
  # THE HEADLINE: the `voice` extension the gate tells it to prefer is the exact regression
  # here. This fails if someone drops the "what a voice provider means for THIS skill"
  # paragraph and leaves the gate's "prefer libi's own extension" standing unqualified.
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_speech]", expect: absent }
  # …and it never starts down the install path toward one either.
  - { transcript_contains: "[tool-call mcp__libi__libi_tts_download_model]", expect: absent }
  # The carry survived the endpoint id leaving the body: the agent still explains the
  # mechanism by its token, which is what `ai-video-models` documents the grammar for.
  - { transcript_contains: "@Audio1", expect: present }
  # The honest exit names a tool, and it is the VIDEO kind. Before the body carried
  # this call there was nothing for the agent to DO at the end of the turn.
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: present }
  - { transcript_contains: '"kind":"video"', expect: present }
  # …and never the `voice` kind, which can only offer elevenlabs/kokoro for a job that
  # needs a video model. This is what the (now removed) gate's step 2 would have produced.
  - { transcript_contains: '"kind":"voice"', expect: absent }
  # It did not improvise a provider or invent an endpoint with none connected.
  - { endpoint_id: "*", expect: absent }
  - { unknown_endpoint: true, expect: absent }
  - { provider: "fal", expect: absent }
  - { provider: "elevenlabs", expect: absent }
```

## Behavioral expectations
- Explained that each clip is generated WITH its voice (`generate_audio: true`) and that
  consistency comes from carrying clip-1's extracted audio into the later clips as
  `@Audio1` on a reference-conditioned generation — not from one narration track over
  silent clips.
- Did **not** offer, install or call `libi.generate_speech` as the way to give this video
  its voice, and did not propose muting the clips.
- Said what is actually missing: a **video** provider, and called
  `libi.suggest_provider({ kind: "video", … })` to show the user how to add one. Did not
  present the on-device voice extension as a substitute for one, and did not ask for an
  API key.
- If it mentioned changing the voice deliberately at all, routed that to the
  `voice-replacement` skill as a separate step after the video exists.
- Did not claim a video or a voice had been produced.

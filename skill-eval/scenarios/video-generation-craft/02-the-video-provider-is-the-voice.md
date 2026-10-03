---
id: video-generation-craft-video-provider-is-the-voice
title: A generated video's voice comes from the video generation, not from the on-device voice extension
skills: [video-generation-craft, generic-video]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 480
covers: [video-generation-craft, native-audio, voice-carry, no-tts-layer, extension-is-not-always-the-answer, kokoro, reference-only-skill, suggest-provider]
---

> **Why this scenario exists.** For a generated video "which provider do I need?" has a
> counter-intuitive answer: the voice comes out of the VIDEO generation (`generate_audio:
> true`), and one voice across clips comes from a *reference-conditioned* generation, so the
> deciding provider is the video one and a TTS tool is the regression the voice reference of
> `video-generation-craft` exists to stop. With only libi's own tools connected, the one voice
> tool in the list is `libi.generate_speech`, the one the agent must not reach for.
>
> **The craft skill is reference-only.** It carries no provider gate and calls no generation
> tool; the entry point that loads it (`generic-video` here) gates on `video`, and the answer
> to "no video provider" is `libi.suggest_provider({ kind: "video" })`, then stop.
>
> **Why `mcps: []`.** `/api/skill-eval/configure` calls `setTestModeFakesEnabled(mcps.length > 0)`,
> so an empty list is a session with libi's own tools and no remote provider at all. Putting a
> video provider in front of the agent would let it satisfy the request without ever facing the
> choice; leaving one out makes the choice the whole turn. It also keeps the run free: nothing
> is generated, and the Kokoro model is never pulled (an assertion pins that).
>
> **Why this is the inverse of `music-creation/01` and `audio-analysis/01`.** There, libi's own
> extension IS the right answer for the kind and calling `libi.suggest_provider` is the failure.
> Here the extension exists, is free, is on-device, and is still the wrong tool for this job, so
> the pass is the agent NOT calling it. It is a routing assertion, not a cost one.
>
> **Needle shapes.** A skill load renders as `[tool-result ok] "Launching skill: <name>"`; libi
> tool calls render under their ACP wire title (`[tool-call mcp__libi__libi_generate_speech]
> {args}`, args JSON-serialized; `scripts/skill-eval/harness.ts`), the convention
> `_meta/no-provider.md` documents. Paid-path assertions key on `endpoint_id` /
> `unknown_endpoint` / `provider`, never on `tool`.

## Prompt
I'm making a 25-second AI video for my skincare brand — one woman talking straight to
camera the whole way through. It's too long for a single clip, so it'll be a few. The
thing I care about most is that she sounds like the SAME person from start to finish, not
a different voice each clip. Tell me exactly how the voice is going to work, and set it up.

## Hard invariants
```yaml
assertions:
  # It loaded a skill that carries the answer: the entry point that gates (`generic-video`), or the craft
  # skill directly (the question is about voice carry across clips, which is its own subject). Both were
  # observed; both reach the same references, and the assertions below are what pin the behaviour.
  - { transcript_contains: ['Launching skill: generic-video', 'Launching skill: video-generation-craft'], expect: present }
  # THE HEADLINE: libi's own `voice` extension is the exact regression here: a TTS track laid
  # over silent clips.
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_speech]", expect: absent }
  # …and it never starts down the install path toward one either.
  - { transcript_contains: "[tool-call mcp__libi__libi_tts_download_model]", expect: absent }
  # The agent explains the carry by its token, which the engine and voice references of
  # `video-generation-craft` document.
  - { transcript_contains: "@Audio1", expect: present }
  # The honest exit names a tool, and it is the VIDEO kind.
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: present }
  - { transcript_contains: '"kind":"video"', expect: present }
  # …and never the `voice` kind, which can only offer elevenlabs/kokoro for a job that
  # needs a video model.
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

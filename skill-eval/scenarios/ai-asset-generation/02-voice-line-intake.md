---
id: voice-line-default-when-unanswerable
title: A video request that never mentions audio gets a spoken line, not an ambient-only clip
skills: [ai-asset-generation, using-storyboard, voiceover-production]
mcps: [fal-ai]
agent: claude-code
runs: 1
timeoutSec: 900
covers: [voice-line-intake, native-audio, no-silent-ad, unanswerable-default]
---

## Prompt
Make me a 6-second vertical clip of a barista pouring latte art in a sunlit café,
slow push-in, warm tones. Use Seedance.

## Hard invariants
```yaml
assertions:
  # The pre-authorized preamble forbids pausing on questions, so the voice-line
  # intake cannot be asked here — the rule's fallback applies: a spoken line
  # drafted from the brief. Native audio on, dialogue in the prompt.
  - { tool: submit_job, endpoint_id: "bytedance/seedance-2.0/*", where: "input.generate_audio != false", expect: present }
  - { transcript_contains: ["says:", "says \"", "says “", "VO:", "voice-over:", "Voiceover:"], expect: present }
  # The exact phrase the silent ad shipped with — deciding "no line" for the user.
  - { transcript_contains: ["no speech, no music", "no speech; no music", "no dialogue, no music", "nobody speaks", "no one speaks", "no dialogue."], expect: absent }
```

## Behavioral expectations
- Drafted a short spoken line for the barista/voice-over sized to ~6 s, put it in the clip
  prompt as dialogue and on the storyboard card's `voiceover.line`, and showed it in the
  cost disclosure before generating.
- Did NOT set `generate_audio = false` and did not describe the clip as silent.
- Did not ask the question per clip or re-decide audio outside the intake rule.

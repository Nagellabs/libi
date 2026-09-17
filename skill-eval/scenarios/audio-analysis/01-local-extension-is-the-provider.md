---
id: audio-analysis-local-extension-is-the-provider
title: With no remote provider connected, a transcript routes to libi's own Whisper extension instead of stopping
skills: [audio-analysis]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 480
covers: [provider-gate, audio-analysis, transcription, local-first, whisper, extension-is-a-provider, no-suggest-provider, needs-install]
---

> **Why this scenario exists.** `audio-analysis` is the second skill in the set (after
> `music-creation`) whose provider for its kind is libi's **own on-device extension** —
> Whisper, catalog id `whisper`, extension id `whisper`, tool
> `libi.analysis_transcribe_audio`. It is in fact the sharper case of the two:
> `providersForKind("transcription")` in `lib/providers/catalog.ts` returns **`[whisper]`
> and nothing else**, so there is no remote transcription provider for the gate to fall
> back to. Without the amendment establishing that libi's own extension tools count as a
> provider for their kind, the gate reads "no provider connected → call
> `libi.suggest_provider` and stop", and the user is handed a chat card whose only offer is
> the on-device model that was already the right answer. A later split moved the
> ElevenLabs `speech_to_text` specifics out of `SKILL.md` into
> `references/providers/elevenlabs.md`, which — as with a similar split elsewhere — makes
> that misread *easier*, because the body no longer has any provider but Whisper in view.
> This scenario is the regression test for the amendment on the transcription kind.
>
> **Why `mcps: []`.** `/api/skill-eval/configure` calls
> `setTestModeFakesEnabled(mcps.length > 0)`, so an empty list is a session with libi's own
> tools and no remote provider at all. It is the **inverse** of `_meta/no-provider.md`:
> there libi genuinely cannot produce the kind, so `suggest_provider` + stop is the pass;
> here libi DOES have a provider for the kind, so `suggest_provider` is the FAILURE and
> reaching `libi.analysis_transcribe_audio` is the pass. It also keeps the fake ElevenLabs
> `speech_to_text` off the tool list, so the run cannot accidentally satisfy the request
> through the paid path.
>
> **Why the prompt names a repo-relative path.** The harness creates an **empty** piece and
> seeds no media (`scripts/skill-eval/harness.ts` — `POST /api/pieces` with no body), and
> transcription, unlike generation, needs an input file. `libi.upload_file` resolves its
> `filePath` with a bare `fs.access`, and the harness spawns libi with
> `cwd: REPO_ROOT`, so a repo-relative path lands. `__tests__/fixtures/audio/jfk.wav` is
> ~11 s of real speech already in the tree. Naming it in the prompt is what makes this
> scenario cheap and deterministic; a "transcribe this clip" prompt with nothing in the
> piece just makes the agent hunt the filesystem (see
> `skill-eval/runs/2026-09-08T22-41-16-819Z/speech-captions-synced`, which does exactly
> that and never reaches a provider decision at all).
>
> **Why `needs_install` is the expected outcome, not a failure.** The hermetic temp
> `LIBI_HOME` has no `uv` and no Whisper weights, and `transcribeAudio`
> (`lib/analysis/manager.ts`) checks `isWhisperModelInstalled` **before** it looks the file
> up — so the call answers `{ status: "needs_install", provider: "whisper", hint }` and a
> real transcript never happens in this harness. The pass is the agent surfacing that and
> following the install flow, not routing around it. The path terminates safely on its own:
> `mcp/bundled-mcps/plans/whisper.md` step 2 forbids the agent from installing `uv` itself
> (it is a Download button on the extension card), so it blocks there rather than pulling
> ~480 MB of weights. An assertion pins that anyway, and the model pull itself runs through
> `uv` (`lib/jobs/runners/whisper-model-download.ts`), so it could not succeed regardless.
>
> **Needle shapes.** A skill load renders as `[tool-result ok] "Launching skill: <name>"`;
> the bare name is not enough, because the agent's own reasoning names skills it did not
> load. libi tool calls render under their ACP wire title —
> `[tool-call mcp__libi__libi_analysis_transcribe_audio]` — the convention
> `_meta/no-provider.md` documents, not the dotted `libi.` form. The paid-path assertions
> are keyed on `endpoint_id` / `unknown_endpoint` / `provider`, never on `tool`.
>
> **What is NOT assertable here.** "The agent should prefer the free path" cannot be
> tested by putting a paid one in front of it: the harness preamble tells the agent it is
> *"PRE-AUTHORIZED to run the entire workflow to completion, including every paid
> generation tool"*, and in `skill-eval/runs/2026-09-09T07-43-59-179Z` an agent that had
> read the provider reference and correctly summarised it still took the paid fallback,
> citing that pre-authorization. Removing the paid provider removes the conflict; the gate
> amendment is the sharper thing to test regardless.

## Prompt
Upload `__tests__/fixtures/audio/jfk.wav` into this piece — that path is relative to the
directory libi itself is running from, so pass it to `libi.upload_file` as-is — and then
get me a transcript of it with word-level timings.

## Hard invariants
```yaml
assertions:
  # It loaded the skill whose routing this scenario tests.
  - { transcript_contains: 'Launching skill: audio-analysis', expect: present }
  # THE HEADLINE: it treated libi's own extension as the transcription provider and called it.
  - { transcript_contains: "[tool-call mcp__libi__libi_analysis_transcribe_audio]", expect: present }
  # …and got the harness's expected answer, which it must surface rather than route around.
  - { transcript_contains: "needs_install", expect: present }
  # THE INVERSE OF _meta/no-provider.md: libi HAS a provider for this kind, so the gate's
  # shopping path must NOT fire. This is the assertion that fails if someone "fixes" the
  # gate by dropping the extensions-count-as-a-provider clause — or if that body grows
  # back a "no provider? call suggest_provider" exit that only ever answers "whisper".
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: absent }
  # It did not improvise a provider or invent an endpoint when the local one needed setup.
  - { endpoint_id: "*", expect: absent }
  - { unknown_endpoint: true, expect: absent }
  - { provider: "fal", expect: absent }
  - { provider: "elevenlabs", expect: absent }
  # Cheapness is an invariant, not a hope: the ~480 MB weights pull is never started,
  # because the install plan's `uv` gate is the agent's stopping point.
  - { transcript_contains: "[tool-call mcp__libi__libi_whisper_download_model]", expect: absent }
```

## Behavioral expectations
- Treated `libi.analysis_transcribe_audio` as the transcription provider — free, on-device,
  no key — rather than reporting "no transcription provider is connected".
- Uploaded the file first and worked from the returned `fileId`, rather than trying to run
  an STT over the raw path.
- On `needs_install`, surfaced it and followed the install flow
  (`libi.get_install_plan({ mcpId: "whisper" })`) instead of switching provider. Stated the
  model size (~480 MB for `small`) before proposing the download.
- Stopped at the `uv` gate rather than installing `uv` itself — the plan reserves that for
  the user, via the Download button on the Whisper extension card.
- Did **not** ask for an API key, did not suggest the user go buy a transcription provider,
  and did not fabricate a transcript or invent word timings to fill the gap.
- Did not claim a transcript exists. An honest "here's what it needs first" is the pass.

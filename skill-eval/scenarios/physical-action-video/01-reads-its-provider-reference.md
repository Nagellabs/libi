---
id: physical-action-video-reads-its-provider-reference
title: The manipulation-beat craft skill opens its provider reference before it names an endpoint, and asks before spending
skills: [physical-action-video, ai-video-models, ai-asset-generation, realistic-image-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
timeoutSec: 480
preauthorize: false
covers: [physical-action-video, provider-reference-read, flf, no-invented-endpoint, no-silent-spend, preauthorize-opt-out]
---

> **Why this scenario exists.** An earlier review asked that `physical-action-video`
> actually OPEN its provider reference. The skill half shipped — an imperative step 3 in the
> gate ("Read `references/providers/<id>.md` under this skill BEFORE your first provider
> call… Every concrete model id in this skill is in that file and nowhere else in the body.
> Skipping it is how an agent ends up inventing an endpoint") plus a unit guard — but the
> scenario half was impossible, because there was no `skill-eval/scenarios/physical-action-video/`
> directory at all. One of the more complex routing skills shipped with **zero** agent-level
> coverage: its reference-read behaviour was asserted only by a test that reads the skill
> file, which proves the sentence exists, not that an agent obeys it.
>
> **Why this scenario is cheap, and why that is not a compromise.** The thing under test is
> what the agent does BEFORE its first generation: does it open the reference, and does the
> endpoint it names come from there rather than from memory? None of that needs a generation.
> Going further would: an FLF call takes `image_url` + `end_image_url`, the fake fal now
> rejects unfetchable `*_url` inputs, so the agent would have to generate two keyframes and
> push each through `mcp__fal-ai__upload_file` — several minutes and a much larger surface
> for an unrelated failure to masquerade as a routing defect.
>
> **Why `preauthorize: false` rather than "don't generate" in the prompt.** Asking the prompt
> to forbid generation while the harness preamble tells the agent it is *"PRE-AUTHORIZED to
> run the entire workflow to completion"* puts two instructions in conflict, and the
> pre-authorization has won that fight before (see `music-creation/01`'s development
> history). The pre-authorization opt-out removes the conflict at the source: free work proceeds, spending
> requires an answer nobody gives. The `run_model` / `submit_job` absences below are then
> assertions about the product, not about prompt wording.
>
> **Why `mcps: [fal-ai]`.** The reference under test is `references/providers/fal.md`, so fal
> has to be the connected provider for the gate to route to it. The free discovery calls the
> agent needs to confirm what it read — `recommend_model`, `get_model_schema`, `get_pricing`
> — all work on the fake and cost nothing.
>
> **Needle shapes.** A skill load renders as `[tool-result ok] "Launching skill: <name>"`.
> The reference read renders inside whichever tool the agent uses to open the file — a `Read`,
> a `Terminal` `sed`, a `Grep` — so the needle is the PATH, which appears in all of them
> (`skill-eval/runs/2026-09-09T10-15-39-134Z` shows the Terminal shape). Endpoint assertions
> key on `endpoint_id` / `tool` / `unknown_endpoint`, never on a tool name.
>
> **Why `unknown_endpoint: true, expect: absent` is the sharp one.** The fake serves an
> unknown id with a placeholder rather than an error (non-strict is the default), so an
> invented endpoint would otherwise LOOK like success. The recorder's flag is the only thing
> that separates "used the id from the reference" from "made one up that happened to work
> here and would 404 on real fal" — which is the exact failure the skill's step 3 names.

## Prompt
Before we spend anything: I want one beat where a hand tilts a French press and pours coffee
into a mug — the pour has to actually read as a pour, not a jump cut. Work out how you'd
generate that beat: which model and endpoint you'd use, how you'd structure the prompt, and
what it would cost. Don't generate anything yet.

## Hard invariants
```yaml
assertions:
  # It loaded the craft skill for a manipulation beat.
  - { transcript_contains: 'Launching skill: physical-action-video', expect: present }
  # THE HEADLINE: it opened the skill's own provider reference. Every concrete model
  # id this skill uses lives there and nowhere else in the body.
  - { transcript_contains: "physical-action-video/references/providers/fal.md", expect: present }
  # …and the endpoint it came back with is the one that file names as the default FLF route,
  # not one recalled from training data.
  - { transcript_contains: "fal-ai/veo3.1/fast/first-last-frame-to-video", expect: present }
  # It did not invent an endpoint. The fake placeholders an unknown id rather than erroring,
  # so this flag is the only thing that distinguishes "read the reference" from "guessed".
  - { unknown_endpoint: true, expect: absent }
  # NO SILENT SPEND: planning is free, generating is not, and nobody authorized it.
  - { tool: "run_model", expect: absent }
  - { tool: "submit_job", expect: absent }
  - { provider: "elevenlabs", expect: absent }
```

## Behavioral expectations
- Read `physical-action-video/references/providers/fal.md` before naming any endpoint, and
  named the FLF endpoint that file carries rather than one from memory.
- Reached for FLF (first-last-frame) as the approach for a manipulation beat, which is the
  skill's headline rule — not a plain text-to-video prompt of "a hand pouring coffee".
- Decomposed the pour into one-verb sub-steps with the object anchored and the affordance
  pre-conditions stated, rather than handing the model a single compound sentence.
- Priced the work and asked before running it. Ending the turn at that question is the pass.
- Did not generate anything — no clip, no keyframes pushed to a provider — and did not claim
  it had.

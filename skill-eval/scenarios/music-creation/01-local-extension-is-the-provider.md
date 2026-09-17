---
id: music-creation-local-extension-is-the-provider
title: With no remote provider connected, music routes to libi's own extension instead of stopping
skills: [music-creation, ai-asset-generation]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 480
covers: [provider-gate, music-creation, local-first, ace-step, extension-is-a-provider, no-suggest-provider, needs-install]
---

> **Why this scenario exists.** `music-creation` is the one generation skill whose default
> provider is libi's **own on-device extension** (ACE-Step — catalog id `ace-step`,
> extension id `local-music`, tool `libi.generate_music`) rather than a remote one. That is
> exactly the case the gate amendment establishing that *"libi's own extension tools
> count as a provider for their kind"* was written for. Without it the gate reads "no
> provider connected → call `libi.suggest_provider` and stop", and the user gets sent
> shopping for a paid music provider for a job the free local model already covers. A
> later split moved the paid ElevenLabs and fal paths out of `SKILL.md` into
> `references/providers/*.md`, which makes
> that misread *easier*, not harder — the body no longer has a paid provider in view to
> anchor on. This scenario is the regression test for the amendment. Before it, the suite
> had NO dedicated music scenario at all; the nearest coverage was
> `mimic-video/01-instagram-reel-reuse-music.md`, which loads 21 skills and 6 MCPs to test
> something else.
>
> **Why `mcps: []`.** `/api/skill-eval/configure` calls
> `setTestModeFakesEnabled(mcps.length > 0)`, so an empty list is a session with libi's own
> tools and no remote provider at all. This is the **inverse** of `_meta/no-provider.md`:
> there, libi genuinely has nothing that can make video, so calling `libi.suggest_provider`
> and stopping is the pass. Here libi DOES have a provider for the kind — the extension —
> so `suggest_provider` is the FAILURE and routing to `libi.generate_music` is the pass.
> Confirm `acp_cache_built` logs `["libi"]` — ONE name — before trusting a result.
>
> **Why `needs_install` is the expected outcome, not a failure.** The harness boots libi
> under a fresh temp `LIBI_HOME` with no ACE-Step weights and no `uv`, so
> `libi.generate_music` answers `status:"needs_install"` with the ~8.3 GB size
> (`mcp/tools/music-tools.ts#generateMusic`). The pass is the agent surfacing that and the
> install plan. The path terminates safely on its own: `local-music`'s plan explicitly
> forbids the agent from installing `uv` itself (it is a button on the Libi MCP tab), so
> the agent blocks there rather than pulling 8.3 GB. An assertion pins that anyway.
>
> **Needle shapes.** A skill load renders as `[tool-result ok] "Launching skill: <name>"`;
> the bare name is not enough, because the agent's own reasoning names skills it did not
> load. libi tool calls render under their ACP wire title —
> `[tool-call mcp__libi__libi_generate_music]` — the convention `_meta/no-provider.md`
> documents, not the dotted `libi.` form. The paid-path assertions are keyed on
> `endpoint_id` / `unknown_endpoint` / `provider`, never on `tool`: a
> `{ tool: "run_model", expect: absent }` would still pass if the agent reached a different
> paid model through the same tool.
>
> **Development history — why the scenario is shaped this way.** Three earlier drafts put a
> paid provider in front of the agent (`mcps: [fal-ai]`, which attaches the fal AND
> ElevenLabs fakes) and asserted it would not be used. That is not assertable in this
> harness: its own preamble tells the agent it is *"PRE-AUTHORIZED to run the entire
> workflow to completion, including every paid generation tool"*. In
> `skill-eval/runs/2026-09-09T07-43-59-179Z` the agent did everything right — loaded
> `music-creation`, tried `libi.generate_music` first, got `needs_install`, fetched the
> install plan, hit the `uv` blocker it is not allowed to clear itself, READ
> `references/providers/elevenlabs.md`, and said in as many words *"the provider reference
> is clear that paid music is opt-in only"* — and then took the paid fallback anyway,
> citing that pre-authorization. The behaviour was correct; the assertion was unwinnable.
> Removing the paid provider removes the conflict, and the gate amendment is the sharper
> thing to test regardless. (That run is also the delivery proof that a
> `references/providers/*.md` file is mirrored into the agent workspace and actually read.)

## Prompt
I want to put some music under this piece but I haven't worked out what it should be —
walk me through it and then get it made.

## Hard invariants
```yaml
assertions:
  # It loaded the skill whose routing this scenario tests.
  - { transcript_contains: 'Launching skill: music-creation', expect: present }
  # THE HEADLINE: it treated libi's own extension as the music provider and called it.
  - { transcript_contains: "[tool-call mcp__libi__libi_generate_music]", expect: present }
  # …and got the harness's expected answer, which it must surface rather than route around.
  - { transcript_contains: "needs_install", expect: present }
  # THE INVERSE OF _meta/no-provider.md: libi HAS a provider for this kind, so the gate's
  # shopping path must NOT fire. This is the assertion that fails if someone "fixes" the
  # gate by dropping the extensions-count-as-a-provider clause.
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: absent }
  # It did not improvise a provider or invent an endpoint when the local one needed setup.
  - { endpoint_id: "*", expect: absent }
  - { unknown_endpoint: true, expect: absent }
  - { provider: "fal", expect: absent }
  - { provider: "elevenlabs", expect: absent }
  # Cheapness is an invariant, not a hope: the 8.3 GB weights pull is never started.
  - { transcript_contains: "[tool-call mcp__libi__libi_music_download_model]", expect: absent }
```

## Behavioral expectations
- Treated `libi.generate_music` as the music provider — free, on-device, no key — rather
  than reporting "no music provider is connected". Stage 6's "if the user has no provider
  opinion, pick local ACE-Step".
- Ran enough of the interview to have something to generate (at minimum a genre/vibe and a
  length) instead of demanding a full spec or inventing one silently.
- On `needs_install`, told the user the **~8.3 GB** size and followed the install flow
  (`libi.get_install_plan({ mcpId: "local-music" })`) rather than switching provider. Did
  not try to install `uv` itself — the plan reserves that for the user.
- Did **not** ask for an API key, did not suggest the user go buy a music provider, and did
  not substitute a silent piece, a sound effect, or a code overlay for the music.
- Did not claim music was added to the piece. An honest "here's what it needs" is the pass.

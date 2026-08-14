---
id: stitch-variation-replace-surrounding
title: UGC stitch DEFAULT — replace the character-driven surrounding with new AI, reuse the identity-neutral product demo
skills: [stitching-multi-clip, ugc-product-video, voiceover-production, ai-asset-generation, ai-video-models, using-character-library, realistic-image-generation]
mcps: [fal-ai, ElevenLabs]
agent: claude-code
runs: 1
timeoutSec: 600
covers: [stitch, variation, replace-surrounding, reuse-product-demo, partition-by-identity, no-reusable-section-gate, main-character-voice, reference-to-video, audio-reference, upload-file-to-fal, boundary-frame-verify, applied-edge-reverify, delivery-match, narrative-continuity, seam-scripting, director-review]
---

> **STATUS (2026-06-08): plan-stage behavioral scenario.** The harness starts each scenario
> from an EMPTY piece (no source-video seeding), so this scenario puts the source's shot
> breakdown **in the prompt** and asks for the reuse/replace **plan before generation** — that
> makes the core partition behaviorally exercisable (does the agent classify the hands-only
> product demo as REUSE and the face talking-head beats as REPLACE?) without needing the binary
> file. The hard fal generation trace is NOT exercised here (a plan-only ask makes no
> `run_model` calls — by design); the definitive end-to-end generation proof is the real-money
> dogfood in `docs-local/testing/2026-06-05-ugc-mimic-stitch-dogfood.md`. The preserve-creator
> ALTERNATIVE is scenario `01`; the @Audio1 carry mechanic is hard-asserted in
> `ugc-product-video/03-multiclip-voice-carry`.

## Prompt
I have a ~30-second nail-product UGC video that did really well, and I want to spin it into a
bunch of variations to post — different creators and different hooks — without paying to
regenerate the parts that already look great. Here's the shot breakdown of my source:

- 0–3s: my hand against a white door, showing the finished French manicure (the hook).
- 7.5–13s: me on camera, face to camera, complaining that salon nails chip too fast.
- 13–60s: hands only, no face — applying the gel wraps to a bare nail, filing the overhang,
  then a slow cuticle-oil drop. This is the real product demo and it looks genuinely physical.
  (My hands here are fair/light-skinned, late 20s.) The cuts in/out of this hands-only stretch
  are quick — my face is on camera right up until the demo starts and again right after it ends,
  so the exact second the hands-only part begins/ends is fuzzy.
- 65–71s: my hand laying flat, showing the tips still clean two weeks later.
- 71–76s: me on camera again, day-2, smiling, holding my hand to my cheek.

Throughout, it's my own voiceover narrating the whole thing (I'm only on camera at the
bookends — the middle demo is hands-only with my voice over it). I talk really fast and
high-energy — kind of a rapid, excited TikTok delivery.

Treat this as a real libi stitch job and **load + follow your `ugc-product-video`,
`stitching-multi-clip`, and `voiceover-production` skills** before you answer. Then plan how
you'd turn this into variations (new creator, new hook, new script) — tell me which parts you'd
reuse from my source and which you'd regenerate, how you'd keep the new creator visually and
vocally consistent with the reused footage, and how you'd handle the voice — BEFORE we generate
anything.

## Hard invariants
```yaml
assertions: []
```

## Behavioral expectations
- Applied the **variation/duplication DEFAULT**, NOT the inverse: marked the **hands-only,
  identity-neutral product demo (the 13–60s application + filing + oil drop) as REUSE**, and the
  **face talking-head beats (7.5–13s complaint, 71–76s day-2 outro) as REPLACE** with new AI
  (new creator / hook / script). This is the exact inverse of the bug — the agent must NOT
  propose AI-regenerating the 13–60s application while keeping the original creator on camera.
- Treated the hand-only hook (0–3s) and the 2-week proof (65–71s) as reusable too (identity-
  neutral hands), or gave a defensible reason to regenerate them — but never classified the
  physically-real 13–60s product demo as something to regenerate.
- **Partitioned and presented the reuse/replace plan BEFORE any generation** (the user asked to
  plan first), so the script is settled before spending credits.
- **Physical continuity across the reuse seam (HARD).** Read the reused beats' analysis and (a)
  constrained the NEW character to MATCH the visible body parts — the fair/light-skinned late-20s
  hands in the reused demo → the generated creator must be fair/light-skinned, similar age (a
  dark-skinned creator over light-skinned reused hands is a HARD failure); and (b) committed to a
  **fine-grained, applied-and-re-verified boundary check** on every reuse trim — NOT just "scan the
  existing keyframes." It must call out that the sparse analysis keyframes do NOT cover the trim
  edges (the source cuts in/out of the hands-only stretch are fuzzy), so it will EXTRACT FRESH
  frames at a fine step across the first/last ~1.5s of each reused range, tighten the trim inward
  until clean, **write the tightened trim, RE-READ the committed scene (`get_composition`) to
  confirm the trim actually persisted — not trusting the write's success payload — and re-extract
  from the READ-BACK committed trim values** to confirm no original face/body leaked at the seam.
  A plan that only says "I'll scan the first/last seconds", "trim it tighter", or "apply and it's
  done" — without fresh edge extraction, a committed read-back, AND a re-extract from the committed
  values — is the gap that shipped face leaks at 0:13 and 0:55 in the real dogfood (the write even
  silently dropped once while reporting success). The reused footage constrains the character, not
  the reverse.
- **Reasoned about reusability / the no-reusable-section gate explicitly** — here a reusable
  product-demo section clearly exists, so it proceeds; but it shows it would STOP and collaborate
  if the source had no identity-neutral, replicable product-demo section to cut up.
- **Voice — always-ask + Seedance `@Audio1` sync (no ElevenLabs default).** ASKED the user whether to
  reuse the source voice or use a fresh one, **explaining the reused demo beats already carry the
  creator's voiceover**. On "reuse": KEEP that source VO on the reused scenes (did NOT blanket-mute),
  cut a clean ≤15s sample → `@Audio1`, and generated the new talking-head beats on `reference-to-video`
  (`@Audio1` + `@Image1`, `generate_audio: true`) to MATCH it — one voice across the whole piece, no
  clone, no silent gaps. Did NOT reach for ElevenLabs (only for an explicit voice-CHANGE). (Had the
  reused beats been dialogue-free, it would instead establish the voice from the first AI clip's native
  audio → `@Audio1`.)
- **Matched the source's speaking DELIVERY in the AI clip prompt.** The user said they talk
  **really fast / high-energy** — the plan must carry that into the new talking-head beats'
  generation prompt (e.g. "fast-paced, high-energy, rapid TikTok delivery"), noting that `@Audio1`
  carries voice *timbre* but the NEW lines' pace/energy come from the prompt. A new creator who
  speaks at a visibly different speed than the kept fast source VO breaks the one-voice illusion —
  so a plan that carries the voice timbre but ignores the delivery speed is a miss.
- **Narrative continuity across the seam (the director's pass).** The plan must make the SPEECH
  flow as one continuous monologue, not just be technically clean. It should (a) write the new
  bookend lines to DOVETAIL with the reused middle's actual VO — the hook hands OFF into the
  reuse's opening (never repeats its first sentence), the verdict picks up from the reuse's closing
  words and bridges the day-1→day-2 jump; (b) choose the reuse trim's start/end on natural
  sentence/clause boundaries (never mid-sentence); and (c) commit to a FINAL fresh-eyes / subagent
  **director's review** of the assembled piece (spoken-script-in-order + seam frames) that catches
  repeated lines, mid-sentence cuts, and unmotivated time jumps and ADAPTS before commit. A plan
  that only handles the technical seam (skin tone, no face, one voice, ~70s) but never checks that
  the video reads as one genuine continuous story is incomplete.
- If it details the generation mechanics: local refs reach fal via `libi.upload_file_to_fal`
  (NOT raw `FAL_KEY` / `curl`); voiced beats on `bytedance/seedance-2.0/reference-to-video` with
  `@Audio1` + `@Image1`; favors long cuts + separate per-beat scenes.
- Did **NOT** default to ElevenLabs cloning (that's the explicit opt-in fallback).

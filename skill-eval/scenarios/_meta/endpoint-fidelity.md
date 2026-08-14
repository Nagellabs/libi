---
id: meta-endpoint-fidelity
title: Agent reaches only canonical fal endpoints (no unknown IDs)
skills: [ugc-product-video, ai-asset-generation, ai-video-models, voiceover-production, realistic-image-generation]
mcps: [fal-ai]
agent: claude-code
runs: 1
timeoutSec: 540
falStrict: true
covers: [endpoint-fidelity, canonical-ids, no-unknown-endpoints, gpt-image-2, seedance-2.0]
---

> **STATUS (2026-06-05): STRICT — KB reconciled against live fal.** Every KB
> endpoint was probed against live fal's openapi schema endpoint and the KB was
> reconciled: removed the phantom `fal-ai/veo-3.1` (404, unreferenced) and the two
> phantom `fal-ai/bytedance/seedance/v2/pro/*` aliases (404). The audit now reports
> 0 unknown and 0 KB-only, so `falStrict: true` is safe — an unknown endpoint
> hard-404s mid-run instead of only being flagged, and no legitimate skill endpoint
> can false-404 (the `endpoint-kb-coverage` drift test guarantees every
> skill-referenced id resolves through the KB). Do NOT loosen the `unknown_endpoint`
> matcher — it is the point.
>
> On its FIRST real run this scenario FAILED and caught a genuine bug: the agent
> called the bare `bytedance/seedance-2.0` (a model family — 404s on real fal)
> instead of the operation-specific `bytedance/seedance-2.0/image-to-video`. The
> fix (clarifying family-vs-endpoint in `ugc-product-video` + `ai-asset-generation`)
> landed and the re-run HARD-PASSES — `unknown_endpoint` matched=0, the agent now
> reaches the canonical suffixed endpoint. That catch→fix→verify is exactly what
> this scenario exists for.

## Prompt
Create a 15-second fully-AI UGC ad for a fictional skincare serum "Dewdrop".
Generate the hero product image AND a product video clip (motion is required —
this is a video ad, not a still), then assemble the 15-second piece.
Use the best image model for product realism.

## Hard invariants
```yaml
assertions:
  # The headline fidelity assertion: every run_model/submit_job hit a KB-known
  # (canonical or aliased) fal endpoint — no hallucinated/non-canonical IDs.
  - { unknown_endpoint: true, expect: absent }
  # Sanity: the realism image model + a seedance clip were actually used,
  # matched on the CANONICAL id (robust to whichever alias string the agent used).
  - { endpoint_id: "openai/gpt-image-2", expect: present }
  - { endpoint_id: "bytedance/seedance-2.0/*", count: ">=1" }
```

## Behavioral expectations
- Reached real, documented fal endpoints only — did not invent a plausible-looking
  but non-canonical endpoint_id string.
- Used `openai/gpt-image-2` for the product still and a Seedance 2.0 endpoint for the clip.

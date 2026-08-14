---
name: ai-video-models
description: Per-engine prompting guides for AI video models (Seedance 2.0, Veo 3.1, Kling). Genre-neutral — how to write a good prompt for each engine (reference-image token, prompt order, length, motion language, FLF, duration caps, style whitelist). Loaded BY creation skills (ugc-product-video, generic-video) once a model is chosen — NOT a standalone entry point.
when_to_use: Loaded by a creation skill after it has chosen a video model, to read that engine's prompting rules before composing a prompt. Not triggered directly by user requests.
tags:
  - generation
  - reference
---

# AI Video Models — per-engine prompting guides

Shared reference. A creation skill (`ugc-product-video`, `generic-video`) loads this once it
has chosen a video model, to read how to prompt that specific engine.

Scope boundary (do not duplicate across skills):
- The **craft** (9-layer formula, clip-duration methodology, realism cues, negative lists)
  lives in `ugc-craft`.
- The **mechanics** (provider discovery, `recommend_model` / `get_model_schema` /
  `get_pricing`, polling, import) live in `ai-asset-generation`.
- **This skill is ONLY the per-engine prompt rules.**
- Genre **use-case formulas** (e.g. the UGC product-hero / feature-walkthrough recipes) live
  in the calling creation skill (e.g. `ugc-product-video`), not here.

## Pick the guide for your chosen model
- **Seedance 2.0** (strong default for most video) → [model-seedance-2](prompts/model-seedance-2.md)
- **Veo 3.1** → [model-veo-3-1](prompts/model-veo-3-1.md)
- **Kling** → [model-kling](prompts/model-kling.md)

Always verify the model at runtime via `ai-asset-generation` (`recommend_model` →
`get_model_schema` → `get_pricing`) before composing — availability, schemas, and pricing
drift. Never trust a hardcoded model id as ground truth.

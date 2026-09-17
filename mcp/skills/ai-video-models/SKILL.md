---
name: ai-video-models
description: Per-engine prompting guides for AI video models (Seedance 2.0, Veo 3.1, Kling). Genre-neutral — how to write a good prompt for each engine (reference-image token, prompt order, length, motion language, FLF, duration caps, style whitelist). Loaded BY creation skills (ugc-product-video, generic-video) once a model is chosen — NOT a standalone entry point.
when_to_use: Loaded by a creation skill after it has chosen a video model, to read that engine's prompting rules before composing a prompt. Not triggered directly by user requests.
tags:
  - generation
  - reference
---

# AI Video Models — per-engine prompting guides

## Provider gate — read this first

You need a **video** provider. libi generates no media itself.

1. **Check your tool list.** If you already have a provider that can do video, use it.
   If this skill ships a reference for it — `references/providers/<id>.md` under this
   skill, where `<id>` is the provider's catalog id (`fal`, `elevenlabs`, `higgsfield`,
   `ace-step`, `kokoro`, `whisper`) — **read that file and follow it**. If there is no
   reference file for your provider, use the provider's own tool docs (its
   `get_model_schema` / `list_models` / equivalent) and keep to the capability and
   constraint rules in this skill. **libi's own extension tools count as a provider**
   for their kind — `libi.generate_music` (music), `libi.generate_speech` (voice),
   `libi.analysis_transcribe_audio` (transcription), `libi.remove_background` (matting,
   not generation). Prefer them by default: they are free and on-device. If one answers
   `needs_install`, follow its install flow (`libi.get_install_plan` / the download
   tools) instead of switching provider.
2. **If you have none** — no remote provider tool and no libi extension for video — call
   `libi.suggest_provider({ kind: "video" })`, tell the user what it showed, and
   **stop**. Do not improvise a provider, do not ask for an API key, and do not fall
   back to a tool that cannot do video.
   If it answers `status: "none"`, there is nothing to connect: everything libi knows of
   for video is already connected or already installed, and its `covered` list names it.
   Do not open anything or ask for a key — use what `covered` names, or, if that
   cannot do what was asked, say plainly what libi cannot do.

`libi.list_providers()` gives you the same picture without putting a card in the chat — use it
for a general "what's connected?". When the user asks about a provider that is not in your tool
list, call `libi.suggest_provider` instead, so the chat shows the buttons to connect it.

Shared reference. A creation skill (`ugc-product-video`, `generic-video`) loads this once it
has chosen a video model, to read how to prompt that specific engine.

Scope boundary (do not duplicate across skills):
- The **craft** (9-layer formula, clip-duration methodology, realism cues, negative lists)
  lives in `ugc-craft`.
- The **mechanics** (picking a model, reading its schema, pricing, polling, import) live in
  `ai-asset-generation`.
- The **provider's endpoint ids and tool names** live in `references/providers/<id>.md`
  under THIS skill — one file, so a renamed endpoint is fixed in one place.
- **This skill is ONLY the per-engine prompt rules.**
- Genre **use-case formulas** (e.g. the UGC product-hero / feature-walkthrough recipes) live
  in the calling creation skill (e.g. `ugc-product-video`), not here.

## Pick the guide for your chosen model
- **Seedance 2.0** (strong default for most video) → [model-seedance-2](prompts/model-seedance-2.md)
- **Veo 3.1** → [model-veo-3-1](prompts/model-veo-3-1.md)
- **Kling** → [model-kling](prompts/model-kling.md)

Always verify the model at runtime before composing — availability, schemas and pricing
drift. Your provider reference (`references/providers/<id>.md`) names the endpoint ids and
the schema/pricing tools to confirm them with. Never trust a hardcoded model id as ground
truth.

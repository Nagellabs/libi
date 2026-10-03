---
name: ai-asset-generation
description: "Generate one AI asset (image, video, speech, sound effect, music or 3D) with a connected provider and save it to the piece: 'generate an image of', 'make a video of', 'create a sound effect', 'design a logo'. Also loaded by orchestration skills that need a single asset made. For a multi-clip video use using-storyboard; for transcripts use audio-analysis."
tags:
  - generation
---

# AI Asset Generation

Needs a provider for the kind you generate (`image`, `video`, `music`, `voice`, or `sfx` for a sound effect): one in your tool list, or a libi extension (those count; speech and music have local ones, below). Read the `references/providers/<id>.md` here for the provider you use before your first call. With none for that kind, call `libi.suggest_provider({ kind })` and stop; the full rule is `libi.read_manual({ section: "providers" })`.

Done looks like: one asset the user wanted, made with a model they could see the cost of, imported into the piece with its provenance. This skill is the call and save layer. The video workflow (which asset when, keyframe to clip) belongs to `using-storyboard`; the craft of a good prompt for an engine, a hard physical beat, a realistic image, or video audio and voice is the `video-generation-craft` skill, which you load when the asset needs it. If the request features a recurring character or item, check `using-character-library` first: its catalog may already hold a reference image.

## What comes from where

| Asset | Source |
| --- | --- |
| image, video, sound effect | your connected `image`, `video`, `sfx` provider; 3D from one that hosts a 3D model |
| speech or narration | **local Kokoro, free, on-device**: `libi.generate_speech({ text, pieceId })`; a `voice` provider only on explicit request or for cloning |
| music | **local ACE-Step, free, on-device**: `libi.generate_music({ prompt, durationSeconds?, pieceId })`; a paid music provider only on explicit request |

Local speech and music have no per-call cost, so skip the model and cost steps and go to import (speech returns `{ file }` already). Speech: `withTimestamps: true` when you will build captions from its `words`; `libi.tts_list_voices` for voices; on `status: "needs_install"` follow `libi.get_install_plan({ mcpId: "local-tts" })` and retry. Music: pass `lyrics` for sung vocals or `instrumental: true` for a bed; on `needs_install` tell the user the download size from the payload (about 8.3 GB) and get approval before `libi.get_install_plan({ mcpId: "local-music" })`; on `confirm_duration` tell them `estimatedSeconds` and re-call with `confirm: true`; on `model_load_failed` run `libi.music_download_model({ force: true })` and retry once; `libi.music_list_styles` gives style hints. When you mention a paid music alternative, name only options you checked in `libi.list_providers()` and your tool list, say that they bill the user's own account, and never offer a generic "a paid provider". Add music with `libi.audio_add_clip`.

Whether a generated video should get a separate spoken track at all is decided in the voice reference of `video-generation-craft` (normally no: the voice comes out of the generation), and re-voicing an existing video is `voice-replacement`.

## Choose, ask, disclose

- If several enabled providers support the kind, ask which; if one does, use it.
- Ask the provider what it has rather than guessing: its reference gives the model-picking procedure, else use its discovery and schema tools. Offer one to three candidates with a cost tier and a one-line summary. For a voice provider, pick the voice (its voice-list tool) instead of a model. A photoreal person, portrait or keyframe is the exception: do not let a recommendation tool choose; `video-generation-craft` has the model rule.
- Ask only what you cannot infer for a specific prompt (subject, action, setting, style, camera, aspect ratio and duration, what to avoid), and how many variants if it matters; default to one, since each is paid.
- **Continuity references.** A character, product or style image the user has goes in with `libi.upload_file`; it reaches a hosted model only through the provider's own upload tool, as its reference names it (a remote provider MCP cannot read a local path: use a local provider MCP, an already-public URL, or tell the user and ask). Never read or handle a provider key, never request a signed upload URL yourself, never `PUT` or `curl` bytes to provider storage; the one exception is a presigned URL the provider's own tool returns (ElevenLabs' `creative_create_asset_upload`), which gets the bytes with only the `Content-Type` it names.
- **Cost.** Paid generation spends the user's money: disclose the cost and wait for a yes before you run. Use the provider's pricing tool (its reference names it), fall back to its public pricing page, multiply by quantity, and say that a page-derived number is an estimate. Keep the tier label the tool returned for `costEstimate.tier`. Never bake prices into your own notes; they go stale.

## Build the prompt

Write a detailed, structured prompt, never a one-line summary, and show it for approval before running (skip that only if the user's saved memories opt out). A good image prompt: "Photorealistic medium close-up of a 30-year-old woman with short dark hair in a navy raincoat walking through a Tokyo alley at dusk. Neon signs reflect on wet pavement. 50mm lens, shallow depth of field. Mood: introspective." A good video prompt adds camera and timing: "Handheld 6-second clip. Same woman stops, looks up at a neon sign, then keeps walking left. Subtle handheld bob, no cuts. 9:16. Continues the dusk-neon palette." Per-engine grammar is in `video-generation-craft`; how your provider frames a prompt is in its reference.

**No text in generated video, on every video prompt.** Generated video scrambles letters, swaps words and fakes signs. Add a clause such as "no on-screen text, no captions, no signs, no labels, no readable text on any object" (in the negative field if the model has one). Rewrite any request in the brief that asks for in-video text: "the brand name on the bottle" becomes "a bottle with a small unbranded label area", and the name, caption or sign text is queued as a text overlay with `libi.add_overlay({ kind: "text" })` after the clip validates. Reject a phone-screen or sign request the same way: leave the contents out and add them as an overlay.

**Native audio stays on** (`generate_audio = true`) for engines that have it; the audio rules are in the voice reference of `video-generation-craft`. One question per brief belongs here:

- **Voice-line intake, once, before the first video generation of a brief** (one message; skip what the user already said; never ask again per clip). `generate_audio = true` only gives a clip a soundtrack; a voice exists only if the prompt carries a spoken line, and a request that never mentions audio gets none. Ask whether it should have a spoken line, and if so what it says (or offer to write it, sized to the duration, and show it with the cost disclosure so they read it before paying). If no line, offer a music bed: libi's free on-device `libi.generate_music` (hand it to `music-creation` after the clips exist), the user's own music provider if connected, or ambient only. On a storyboard the line lives in the card's `voiceover.line` and becomes the prompt's dialogue. If nobody can answer (an automated run that settles questions with defaults), draft a spoken line from the brief, sized to the duration, put it in the prompt, show it in the cost disclosure, and state the audio decision; narration fits any shot, so "no speaker in frame" is no reason to skip it. You may not decide "no line" for the user.

## Run

- Short jobs (an image, a single audio) run synchronously. Long ones (video, batches) are submit then poll.
- Wait between polls with `libi.sleep({ seconds: 20, reason })`: it is server-side, cancellable and reports progress. Never a shell sleep or a self-scheduled wakeup. The cadence and the provider's tool names are in its reference.
- Submit the full endpoint id including its operation suffix; a bare model-family id 404s on most providers.
- **A job that reports `completed` is not proof of output.** Treat it as failed, and tell the user, when its inference time is implausibly low for the work, the result URL is missing or 404s, or the file cannot be fetched and imported. A fetched, imported file of the expected kind is the only proof.
- If a job fails, show the provider's error verbatim and ask how to proceed (retry, refine or stop).

## Import and provenance

Base64 result: `libi.save_asset({ pieceId, filename, name, description, type, data })`. URL result: download to a temp path, then `libi.upload_file({ pieceId, filePath, aiGeneration })`. Name files descriptively (`ugc-hook-shot.mp4`, not `output.mp4`). When a flow makes several related files (an extend chain, variants of a beat, a batch of takes), create one folder first with `libi.asset_folder({ action: "create", pieceId, name })` and pass its `folderId` to each upload; a single file needs no folder, and every file is its own asset.

**Pass `aiGeneration` on every AI-sourced upload**; without it the file looks like a plain upload (no Generation tab, no cost lookup, no lineage). Capture the timestamps around the submit, poll and download:

| field | value |
| --- | --- |
| `provider` | the provider's catalog id (`fal`, `elevenlabs`, …) |
| `model` | the exact endpoint id you submitted |
| `prompt` | the full engineered prompt, verbatim |
| `costEstimate` | `{ amount, currency, tier }`, with the pricing tool's own tier label |
| `startedAt`, `completedAt`, `durationMs` | ISO times before the submit and after the download, and their difference |
| `providerJobId` | the provider's request id |
| `attemptNumber` | 0 for the first attempt; raise it on each regeneration |

A filled example is in the provider reference. Then append a lineage line with `libi.update_file_notes`, which other skills read to pick canonical takes: `<ISO timestamp> | model=<id> | retry=<n> | parent=<fileId|null> | prompt-hash=<8 hex> | validation=<ok|minor|reject>` (the hash is the first 8 hex of the prompt's sha256; add validation once a skill graded it).

## Finish

Show the one result that matters (the accepted take, not every candidate) with `libi.show_in_chat({ fileId, caption })`; on a terminal surface without it, use `libi.show({ target: "asset" })` and give the path. Offer to regenerate with refinements or accept. To follow a moving subject in a generated clip, `using-object-tracking`. Never call a generation tool outside this flow: a bad prompt costs real money.

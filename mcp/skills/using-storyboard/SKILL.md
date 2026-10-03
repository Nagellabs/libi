---
name: using-storyboard
description: "Build or plan a multi-card video in the Storyboard tab, including recreate flows and any time you would otherwise write a piece script: free schematic cards, per-card generation specs, keyframes and references, continuity between cards, versioned takes. Not for making a single asset (ai-asset-generation)."
tags: [storyboard, planning, video-creation]
---

# Using the Storyboard

Needs a **video** provider: one in your tool list, or a libi extension (those count). Read the `references/providers/<id>.md` here for the provider you use before your first call. With none, call `libi.suggest_provider({ kind: "video" })` and stop; the full rule is `libi.read_manual({ section: "providers" })`.

Done looks like: an ordered board of cards the user reviewed for free before any spend, each card carrying a generation spec that validates against its model's real schema, with generated takes selected onto the timeline. The storyboard replaces a piece script: a card holds the script content (title, role, voiceover, duration) and the visuals.

Each card has two parts:

- **A schematic (free):** a rough illustration you author that conveys composition, framing, subject placement and lighting direction. It is a loose layout idea the image model is free to vary and improve on, never a drawing to reproduce.
- **A generation spec (paid output):** a per-endpoint description you author after reading the model's real API: keyframes, references, audio and parameters. libi hardcodes no model's fields; a schema cache and validation keep you honest, which is also why outside providers and brand-new models work.

## What is required and what is not

The only hard requirement is the chosen model API's own required params, enforced by `libi.set_storyboard_generation` against the cached schema. The sketch, the keyframe and the keyframe-to-clip chain are encouraged defaults you apply with judgment:

- A crude sketch followed literally yields a crude keyframe: tell the image step to take layout and framing from it and to own realism and detail, and drop it if it hurts.
- A keyframe can come from the prompt and character reference alone, and a clip can run from the prompt with no start frame.
- **Dropping the sketch means generating with no sketch conditioning. It does not mean leaving the auto-seeded blank scaffold in place as the schematic.** A card the user reviews must show a painted schematic, because the free review exists so they see the actual blocking before any spend.

## Changing a board

- **Create cards with `libi.add_storyboard_card({ pieceId, card, overview?, budgetUsd? })`**, the only create tool: it starts a board on a piece that has none and adds each card. Only `card.title` is required; set `overview` and `budgetUsd` on the first card. It writes a rough-canvas unit for the `start` slot and returns the card and its on-disk paths. Never hand-write `manifest.json` or `card.json`.
- **Refine by editing files.** `libi.storyboard_get({ pieceId })` returns each card and the absolute paths of its files: `cardJson` and, per sketch slot, `sketches[]` with the slot's `unit` (its render source) and `sketch` (the rendered PNG). Edit those files to change blocking, camera, prompt or a drawing; the server watches, validates and re-renders. Use `libi.edit_storyboard_card` to add, remove, reorder or re-key sketch slots and to edit scalar fields (title, role, promptFragment, durationSec, camera, voiceover).
- **Paid or irreversible steps are tools, never a side effect of a file edit.** `libi.storyboard_take({ action: "attach_clip", pieceId, cardId, fileId, costUsd })` appends a versioned take (`v1`, `v2`, ...) and selects the first; `libi.storyboard_take` action `select` puts a take on the timeline (the selected take is the card's video overlay); action `hide` hides one; action `approve_stage` approves a tier.

## The generation spec and the schema-cache gate

Every card carries a generation spec. Before setting one, always:

1. `libi.model_schema_cache({ action: "get", apiUrl, model })` returns `{ exists, stale, fetchedAt, schema }`.
2. If it does not exist or is stale, read the endpoint's real API through the hosting provider's own schema tool (the provider reference names it), normalize it to `GenFieldDef[]` (`{ key, type, required?, options?, min?, max?, step?, multiple?, label?, description?, default? }`, `type` one of text, number, boolean, url, enum, image, video, audio, svg, pdf), and `libi.model_schema_cache({ action: "save", apiUrl, model, fields, source? })`.
3. `libi.set_storyboard_generation({ pieceId, cardId, tier: "keyframe" | "clip", spec })` with `spec = { apiUrl, model, params }`; `params` holds only the values you set, and media values are libi `fileId`s. It refuses with `schema_cache_missing` if there is no fresh cache (populate it and retry) and returns `schema_validation_failed` with the issues (unknown key, wrong type, value outside `options`, out of `[min, max]`, missing required). Fix the flagged params and retry rather than abandoning the spec.
4. If a later generation fails because the model rejected a param the cache thought valid, `libi.model_schema_cache({ action: "invalidate", apiUrl, model })` and fetch the schema again.

What to look for in an endpoint's API (discover it, there are no per-model tables here): keyframing (`start_frame`, `end_frame`, optional intermediate frames); references (reference images, character or style references, `reference_video` for motion or scene continuity); audio (`audio_ref`, `generate_audio`); parameters (duration, aspect ratio, resolution, seed, guidance, camera). Set start and end frames by default. The user can edit params inline in the Storyboard tab; an inline edit never fires a generation, so regenerate only when asked.

**A sketch slot's `paramKey` must equal the model's real param, or the sketch never pairs with its image.** The card joins a sketch to its generated image on `clipGen.params[paramKey]`. The default `start` slot is seeded with the placeholder `start_frame` before a model is chosen, and real names differ (an image-to-video endpoint may use `image_url` and `end_image_url`). Once you have read the schema, re-key every slot with `libi.edit_storyboard_card({ pieceId, cardId, editSketch: { slotId, paramKey } })`, and set the image in `set_storyboard_generation` at that same key. If the model has no param for a role, switch to an endpoint that does or remove the slot: never generate an image the clip cannot consume.

**Continuity between cards** is a live link, not a copied file: `libi.set_storyboard_reference({ pieceId, cardId, paramKey: "reference_video", fromCardId })` makes a card follow the previous card's selected take, and swapping that take updates it automatically.

## The card is the spec: read it fresh before you spend

The user can edit a card's params inline at any time, so what you authored earlier may be stale when you spend. Immediately before each generate or regenerate, re-read the card with `libi.storyboard_get` and build the provider request from its current spec (`apiUrl`, `model`, `params` of the tier you are about to run), honoring every manual edit: aspect ratio, seed, duration, a swapped keyframe or reference file, the audio toggle, the prompt fragment. A difference from what you last wrote means the user changed it: adopt it, and if it no longer validates against the schema, run `set_storyboard_generation` to surface the issue rather than dropping the edit. A `reference_video` link resolves to the source card's currently selected take, so reading at spend time also picks up a take the user switched upstream.

## Workflow

1. **Read or seed.** `libi.storyboard_get`; if it returns `{ storyboard: null }`, create the first card with `add_storyboard_card`.
2. **Create the cards** with what you know (`role`, `durationSec`, `camera`, `promptFragment`, `voiceover`). A card's `voiceover.line` is its spoken line, settled once per brief at the voice-line intake in `ai-asset-generation` (a line, or no line and a music bed offered), so the user reviews the words with the schematic. **Paint the `start` slot into a real illustration** by editing its unit file (`prompts/rough-illustration-unit.md` has the contract, the `rough` API and an example; `prompts/block-driven-unit.md` is the Satori-boxes alternative; `svg` and plain `canvas` kinds also work): rough shapes for the subject, setting, composition and camera framing the prompt describes. Paint `end` and `reference` sketches on demand. The sketch is full-bleed, with no caption bar, tag or border, which would leak into the image reference. Presenting the board or spending while a schematic is still the blank scaffold is a failure.
3. **Present and get approval.** `libi.show({ target: "storyboard", pieceId })` takes the user to the board; call it again whenever you change the board. Walk the schematics, revise on feedback, and spend only on a card whose schematic the user approved.
4. **Sketch every conditioning frame, then generate its image (paid).** Image inputs are role-tagged sketch slots: `start`, `end`, and `reference` sketches as the scene needs (a held product, a hand pose), added with `edit_storyboard_card({ addSketch: { role, paramKey, label? } })`. For each, register the rendered sketch (`sketches[i].sketch`) with `libi.upload_file`, put it and the character reference on the provider with its own upload tool, and call the image model's composition-reference endpoint (the provider reference names it; image craft is in `video-generation-craft`) with the sketch, the character reference and the card's `promptFragment`. Use the same character reference on every keyframe, upload the result as a libi file, and set it at the slot's re-keyed `paramKey`. Show the meaningful sketch or keyframe in chat once (`libi.show_in_chat`, or `libi.show({ target: "asset" })` where it is absent), not every re-render.
5. **Author the clip spec, re-read the card, generate (paid).** Set the clip spec through the schema-cache gate (start frame when you have a good one, end frame, a `reference_video` link to the previous card for continuity), re-read the card, and build the request from its current spec. A card's `voiceover.line` is the clip prompt's dialogue in the engine's own format (`video-generation-craft`) with audio on; a card with no line gets no dialogue and keeps ambient native audio. Generate through `ai-asset-generation`, upload, then `libi.storyboard_take` action `attach_clip`.
6. **Select the take.** `libi.storyboard_take` action `select` places it as the card's video overlay in storyboard order; further takes and switching between them are free, and action `hide` removes one from view. Repeat per card.

After any layout, size or typography change, render and look before you tell the user it is done (the manual's "Putting results in front of the user").

## Cost

`storyboard_get` returns a `costSummary` (`totalUsd`, `budgetUsd`, `remainingUsd`). An N-card board is N image generations plus N video generations, which is real money: before any paid step, disclose the per-card and running cost, confirm, and respect `budgetUsd`. Schematics are free, so iterate there first.

Related: `video-planning` (the block plan the cards execute), `ai-asset-generation` (one asset: call, cost, import), `video-generation-craft` (engine, image, physical-action and voice references), `using-character-library` (the character reference carried across keyframes), `stitching-multi-clip` (consistency across independently produced clips).

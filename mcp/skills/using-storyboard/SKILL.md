---
name: using-storyboard
description: "Use when building or planning a multi-scene video via the Storyboard (the editor's Storyboard tab) — including mimic/recreate flows and any time you'd otherwise write a piece script. Teaches the free schematic tier, the per-endpoint generation spec + model-schema cache workflow (cache-gate → populate → set spec → validate → fix), keyframing/reference/audio params, live continuity references between scenes, and versioned takes."
tags: [storyboard, planning, video-creation]
---

# Using the Storyboard

The storyboard is the piece's plan: an ordered list of **cards**, one per scene. Each
card has a free **schematic** (the blocking spec the user reviews before any spend) and a
**generation spec** that says exactly how the AI clip is produced:

1. **Schematic (free).** A render unit you author draws a rough-canvas illustration
   that conveys scene organization — composition, framing, subject placement, lighting
   direction. It is the cheap, editable spec the user reviews *before any money is spent*.
   It is a **loose layout idea, not a literal target**: when it conditions a keyframe the
   image model is free to vary and improve on it (see "What's optional" below).
2. **Generation spec (paid output).** A generic, per-endpoint spec you author after
   reading the chosen model's API — keyframes, references, audio, and parameters (see
   "Generation spec" below). libi hardcodes no model's fields; you discover them and the
   app keeps you honest with a schema cache + validation. Generating produces a take that
   the user can select onto the timeline.

The strict rung-by-rung lock is relaxed: a schematic + at least one keyframe are **strongly
encouraged, never hard gates**. Timeline placement is driven by the **selected take**, not a
"clip approved" flag.

## What's optional (encouraged ≠ required)

The chain — **sketch → keyframe (image) → clip (video)** — is the encouraged default, but
**every link is independently optional**. The ONLY hard requirement is the chosen model API's
own required params; everything libi layers on top is a recommendation you apply with judgment.

- **The sketch is a loose layout idea — randomize on it.** It informs blocking only. When you
  feed it to the image model, treat it as a *composition reference the model should improve and
  vary on*, not a drawing to reproduce faithfully. Instruct the image step to use it for
  layout/framing and to own the realism, proportions, and detail. **A crude sketch followed
  literally produces a crude keyframe** — so the sketch guides; the model decides the look.
- **Sketch → keyframe is optional.** You may generate a keyframe *without* the sketch (prompt +
  character reference only), and you may **drop the sketch** when it's hurting the result.
  "Drop the sketch" means deliberately generating the keyframe/clip with **no** sketch
  conditioning (text-to-video / prompt + reference). It does **NOT** mean leaving the
  auto-seeded **blank** scaffold in place as the schematic — a card that still shows a
  schematic the user reviews must have that schematic **painted** into the actual scene
  (see step 2). Skipping the sketch tier is a deliberate text-to-video choice; an un-painted
  blank canvas presented as the schematic is the failure this rule does not license.
- **Keyframe → clip is optional.** You may generate a clip with **no** keyframe
  (prompt/text-to-video) when that's better or when no good keyframe exists. `start_frame` /
  `end_frame` stay the encouraged default, never a requirement.
- **Only API-required params are mandatory.** `set_storyboard_generation` enforces exactly the
  cached schema's `required` fields and nothing more — that is the one real gate. The approval
  ladder gates only on the free schematic (review-before-spend), not on a keyframe.

This replaces writing a separate piece script — the card carries the script content
(title, role, voiceover, duration) **and** the visuals.

## The two ways you change a storyboard

**Create cards = `libi.add_storyboard_card` (the ONLY create tool).** To START a
storyboard on a piece that has none, AND to add each scene, call
`libi.add_storyboard_card({ pieceId, card, overview?, budgetUsd? })`. Only `card.title`
is required; everything else defaults, the storyboard manifest is initialized on the
first call, and a **rough-canvas illustration unit** (`kind: "canvas"`, drawn with the
injected `rough`) is written for the `start` slot so a schematic renders immediately.
Set `overview` (and optional `budgetUsd`) on the first card. It returns the card plus
its on-disk paths. **Do NOT hand-write `manifest.json` / `card.json` or
reverse-engineer the on-disk format to bootstrap — use this tool.**

**Refine existing cards = edit FILES + `edit_storyboard_card`.** `libi.storyboard_get({ pieceId })`
returns each card plus the ABSOLUTE on-disk paths of its files: `cardJson`, and a per-slot
`sketches[]` array where each entry has the slot's `unit` (its render source) and `sketch`
(the rendered PNG). To change a card's blocking, camera, prompt, or a sketch slot's drawing,
**edit those files with your normal file tools** — the server watches, validates, re-renders
the sketch, and updates the UI. To add / remove / reorder / **re-key sketch slots**
(`editSketch: { slotId, paramKey }` — point a slot at the chosen model's real clip-gen param)
or edit scalar fields (title, role, promptFragment, durationSec, camera, voiceover), use
`libi.edit_storyboard_card`. `add_storyboard_card` is the create path.

**Paid or irreversible actions = TOOLS (never a side effect of a file edit).** Use:
- `libi.attach_storyboard_clip({ pieceId, cardId, fileId, costUsd })` — after you
  generate + upload a clip. **Appends a versioned take** (`v1`, `v2`, …) and auto-selects
  the first one.
- `libi.select_storyboard_take({ pieceId, cardId, takeId })` — put a take on the timeline
  (the selected take IS the scene). `libi.hide_storyboard_take({ … })` soft-hides one.
- `libi.attach_storyboard_keyframe` / `libi.approve_storyboard_stage` still exist for the
  legacy ladder, but prefer the generation-spec flow below.

## Generation spec (how each card is generated)

Every card MUST carry a **generation spec** — a generic, agent-authored description of how
its clip is produced. libi hardcodes no model's parameters; you read the chosen endpoint's
real API, author the spec, and the app validates it against a cached copy of that API's
schema. This is what makes outside MCPs and brand-new models work for free.

**The cache workflow (the gate). Always do this before setting a spec:**

1. `libi.get_model_schema_cache({ apiUrl, model })` → `{ exists, stale, fetchedAt, schema }`.
2. If `!exists` or `stale`: research the endpoint's **real API** (via the hosting MCP — e.g.
   fal's `get_model_schema`), **normalize it to `GenFieldDef[]`**, and
   `libi.save_model_schema_cache({ apiUrl, model, fields, source? })`. A `GenFieldDef` is
   `{ key, type, required?, options?, min?, max?, step?, multiple?, label?, description?,
   default? }` with `type ∈ text|number|boolean|url|enum|image|video|audio|svg|pdf`.
3. `libi.set_storyboard_generation({ pieceId, cardId, tier: "keyframe"|"clip", spec })`
   where `spec = { apiUrl, model, params }` — `params` carries ONLY the values you set
   (media values are libi `fileId`s). This tool is the safety gate:
   - It **refuses** with `schema_cache_missing` if there's no fresh cache for that
     `(apiUrl, model)` — populate the cache first (step 2), then retry.
   - It **validates** `params` against the cached fields and returns `schema_validation_failed`
     with a list of issues (unknown key, wrong type, value not in `options`, number out of
     `[min,max]`, missing required). **Fix the flagged params and retry — don't abandon the
     spec.**
4. If a later generation **fails because of a param** (the model rejected a value the cache
   thought was valid), `libi.invalidate_model_schema_cache({ apiUrl, model })` and re-fetch
   the schema — the cached shape was stale.

**The idea space — what to look for in an endpoint's API (no per-model tables; discover it):**

- **Keyframing** — `start_frame`, `end_frame`, and optionally intermediate frames (a
  `multiple` image param). Set start + end on almost every video card.
- **References** — reference images, character / style references, and `reference_video`
  for motion/scene continuity.
- **Audio** — `audio_ref` (a voice/sound reference) and `generate_audio` (native audio).
- **Parameters** — duration, aspect_ratio, resolution, seed, cfg/guidance scale, camera.

**Defaults (lean into these):**

- **Sketch start AND end by default; add reference sketches as the scene needs them.** Each
  sketch slot is tagged `start` / `end` / `reference` and bound to a clip-gen param; generate
  an image for each sketch and set it at that `paramKey` before the clip. Set `start_frame` +
  `end_frame` by default — but this is a recommendation, not a rule: drop a sketch/keyframe
  that's hurting the result, and prompt/text-to-video with no `start_frame` is a valid choice
  (see "What's optional" above).
- For a video that **follows another scene**, wire continuity with a **live link** to the
  previous card's selected take instead of copying a file:
  `libi.set_storyboard_reference({ pieceId, cardId, paramKey: "reference_video", fromCardId })`.
  Swapping the source card's take then updates this card automatically. The card shows it
  with a pulsing border + `from sc.NN`.
- **Every card carries a generation spec — the more params you set, the better.** A schematic
  and ≥1 keyframe are strongly encouraged but never required.
- **Show the rendered sketch in the chat.** After a sketch (keyframe image) renders for a slot,
  call `libi.show_in_chat({ fileId, caption })` so it appears inline in the conversation — the
  user shouldn't have to hunt for it on the board. Show the meaningful sketch(es) for the scene,
  not every minor re-render. (In a terminal/CLI surface the tool won't be present — use
  `libi.show_asset` instead.)

**Inline editing (no auto-spend).** The card's params are inline-editable in the Storyboard
tab, typed from the cached schema (enum→select, number→min/max input, boolean→toggle,
media→picker). Editing a param **never** fires a generation — only the explicit Regenerate
(an agent hand-off) does. So when the user says "make it 16:9" or "drop the seed", you can
just set that param via `set_storyboard_generation`; you re-generate only when they ask.

**The card is the source of truth — read it fresh right before you generate.** The card
holds the COMPLETE, current generation request: every param, keyframe, reference, and audio
setting. Because the user can edit those params inline at any time (and inline edits do NOT
fire a generation), the values you authored earlier may be **stale** by the time you actually
spend. So immediately before each generate / regenerate, **re-read the card with
`libi.storyboard_get` and build the provider request from the card's CURRENT generation
spec** — never from params you remember from when you first set them, and never from a
schematic/prompt you drafted before the user touched the board. Concretely:

- **Pull the live spec at spend time.** `libi.storyboard_get({ pieceId })` → take the target
  card's current `generation` spec (the `keyframe` / `clip` tier you're about to run) and use
  exactly those `params`, `apiUrl`, and `model` for the fal/provider call. Honor every manual
  edit the user made (aspect ratio, seed, duration, swapped keyframe/reference file, audio
  toggle, prompt fragment).
- **A reconcile gap means re-read, don't override.** If the card's spec differs from what you
  last authored, the user changed it — adopt the card's values; do not silently revert to your
  version. If a manual edit looks invalid against the cached schema, re-run the cache gate
  (`set_storyboard_generation` will flag it) and surface the issue, rather than dropping the
  edit.
- **This also covers live references.** A `reference_video` link resolves to the *source
  card's currently selected take* — so re-reading at spend time picks up a take the user
  switched on the upstream card, keeping continuity correct.

In short: the card — as it stands at the moment of generation — is the spec. Author into it,
then read back from it when you spend.

## Workflow

1. **Seed/read.** Call `libi.storyboard_get`. If it returns a storyboard, work with it.
   If it returns `{ storyboard: null }`, the piece has no board yet — **create one with
   `libi.add_storyboard_card` (do not reverse-engineer files).** (A piece carrying a
   legacy script is migrated to cards on the first read instead.)
2. **Create the cards, then refine.** For each scene, call `libi.add_storyboard_card`
   with `title` + as much as you know (`role`, `durationSec`, `camera`, `promptFragment`,
   `voiceover`). Set `overview`/`budgetUsd` on the first card. Each call bootstraps a
   minimal rough-canvas scaffold for the `start` sketch slot (`kind: "canvas"`, injected
   `rough` context). **Refine the `start` slot into a full scene illustration by editing
   the unit file** — see `prompts/rough-illustration-unit.md` for the contract, the `rough`
   API, and a worked exemplar. **Paint the `start` keyframe as a full rough illustration
   at card creation; paint `end` + `reference` sketches on demand.** The watcher
   re-renders on every save. **The seeded scaffold is a BLANK placeholder — empty paper
   plus one faint horizon line. It is NOT a finished schematic. You MUST paint the `start`
   slot into a real scene illustration — rough shapes for the subject, setting, composition,
   and camera framing the prompt describes — before you present or approve the card.
   Presenting the board, or spending, while a card's schematic is still the blank seeded
   scaffold is a failure: the free schematic exists precisely so the user reviews the actual
   blocking BEFORE any spend, and a blank horizon shows them nothing.** **Full-bleed — no caption bar, shot-tag, or border baked
   into the sketch** (it would leak into the image-gen reference). To swap a slot to a
   different style — Satori boxes (see `prompts/block-driven-unit.md`), `svg`, or plain
   `canvas` without rough — edit the unit file and set the appropriate `kind`. The
   returned `cardJson` / per-slot `sketches[i].unit` paths are in the `storyboard_get`
   response.
3. **Present the board, get approval.** Navigate the user to the Storyboard tab with
   `libi.show_storyboard({ pieceId })`. Walk the schematics; revise per feedback (edit
   files). Only when the user approves a card's schematic do you spend. **Call
   `libi.show_storyboard` again any time you create or update the board** (revise a
   schematic, attach a keyframe/clip, advance the ladder) so the user sees the change —
   this is the storyboard analogue of `libi.show_preview` for the timeline.
4. **Sketch every conditioning frame, then generate its image (paid).** A card's image
   inputs are **role-tagged sketch slots**: a `start` keyframe (created with the card), an
   `end` keyframe, and `reference` sketches as the scene needs (a held product, a hand pose,
   a style ref). **Sketch `start` AND `end` by default; add `reference` sketches when the
   scene needs one.** Add the extra slots with
   `libi.edit_storyboard_card({ pieceId, cardId, addSketch: { role, paramKey, label? } })` —
   `paramKey` is the clip-gen param the sketch conditions.

   **CRITICAL — a slot's `paramKey` MUST equal the chosen model's REAL clip-gen param**, because
   the card pairs a sketch with its generated image by joining on `clipGen.params[paramKey]`.
   Model param names vary: Seedance i2v uses `image_url` / `end_image_url`, NOT
   `start_frame` / `end_frame`. The default `start` slot is seeded with the placeholder
   `start_frame` *before* a model is chosen — so once you pick the model and read its schema,
   **re-key every slot to that model's real params** with
   `libi.edit_storyboard_card({ pieceId, cardId, editSketch: { slotId, paramKey } })`
   (e.g. start slot → `image_url`, end slot → `end_image_url`). If the chosen model has **no**
   param for a role (e.g. an i2v endpoint with no reference input), either switch to an endpoint
   that does (Seedance `reference-to-video`) or remove that sketch slot — never generate an image
   the clip can't consume. **The image you set in `set_storyboard_generation` and the slot's
   `paramKey` must be the same key, or the sketch won't pair with its image on the card.**

   Each new slot gets a minimal rough-canvas scaffold; refine its drawing by editing the
   unit FILE directly (its absolute path is `cardPaths[cardId].sketches[i].unit` from
   `storyboard_get`) following `prompts/rough-illustration-unit.md` — the watcher
   re-renders. Satori boxes / `svg` / plain `canvas` are all selectable for a slot when
   a different style is wanted.
   Then, **for EACH sketch**, turn it into a real image: register the slot's rendered sketch
   (on disk at `cardPaths[cardId].sketches[i].sketch`) via
   `libi.upload_file({ pieceId, filePath: <that path> })` → `libi.upload_file_to_fal({ fileId })`
   for a fal URL; do the same for the **character reference** image; call
   `openai/gpt-image-2/edit` with the sketch URL as a **loose composition reference** + the
   character URL + the card's `promptFragment`. **Tell the image step the sketch is a layout
   guide to improve and vary on, not a drawing to reproduce** — it owns realism, proportions,
   and detail (delegate the image craft to `ai-asset-generation` / `realistic-image-generation`
   — `gpt-image-2` is the hardened default for realistic people / hands); upload the result as a
   libi file and set it into the clip spec at the slot's (re-keyed) `paramKey` via
   `set_storyboard_generation`. **Carry the SAME character reference across every keyframe** so
   the character stays consistent. On the card, each sketch then pairs with its generated image.

   **The sketch is optional.** If a keyframe comes out poor, regenerate it *without* the sketch
   (prompt + character reference only) or **drop the sketch slot** — a bad sketch followed
   literally only yields a bad keyframe. You may also skip the keyframe image entirely and let
   the clip run from the prompt (see step 5). Don't treat a missing/weak sketch or keyframe as a
   blocker.
5. **Author the clip spec, then generate (paid).** Before generating, set the card's clip
   spec via the **cache workflow** above: `get_model_schema_cache` → populate if missing →
   `set_storyboard_generation({ tier:"clip", spec })` with the keyframe as `start_frame` when
   you have a good one (+ `end_frame`, and a live `reference_video` link to the prior scene for
   continuity). **The keyframe is optional** — when none is good, omit `start_frame` and run the
   clip from the prompt (text-to-video); set only the params the model actually requires.
   **Then re-read the card with `libi.storyboard_get` and build the actual generation
   request from the card's CURRENT spec** (it may carry the user's manual inline edits — see
   "The card is the source of truth" above). Generate the clip with Seedance image-to-video
   from those params (delegate to `ai-video-models` / Seedance 2.0), upload, and
   `attach_storyboard_clip` — which appends a `vN` take.
6. **Select the take → timeline.** `select_storyboard_take` places the chosen take as the
   card's video overlay, sequenced by `startTime` per the storyboard order. Generate more
   takes and switch between them freely; `hide_storyboard_take` removes a take from view.
   Repeat per card.

## Look at what you made (required)

After ANY layout, position, size, or typography change — before you tell the
user it is done — render the affected times and look:

`libi.render_overlay_frames({ pieceId, atTimes: [...], contactSheet: true })`

Read the returned image. Check that text fits its box, that nothing overlaps
or runs off frame (`overflow.touchesEdge` flags the obvious cases), and that
`unresolvedFonts` is empty — a family listed there is rendering in a fallback
face and will look wrong. Reasoning about coordinates is not verification:
a real build got the brand mark overlapping its wordmark, a chip 90px too
narrow for its text, and every text in a serif fallback, all of which one
render made obvious.

## Cost discipline

`storyboard_get` returns a `costSummary` (`totalUsd`, `budgetUsd`, `remainingUsd`). An
N-card board is N image generations + N video generations — real money. Before any paid
step, disclose the per-card and running cost and confirm with the user; respect
`budgetUsd`. Schematics are free — iterate there first.

## Why this beats prompt-only

Prose loses choreography (split-screen blocking, a camera move, shot-to-shot framing).
The schematic captures it explicitly and conditions the keyframe, so each keyframe's
composition is deliberate — and the user reviews it for free before you pay to render.

## Layer map — planning above, the Storyboard in the middle, craft below

**Above the board: `video-planning` (the director).** Before cards are authored, the senior-editor
planning layer decomposes the source/brief into **building blocks** (each block's source-vs-AI,
combine-vs-split, and style inheritance) and presents that plan for the free pre-spend review. Each
block maps to ONE card here (a combined multi-beat block = one card; a split-with-inheritance pair =
two cards joined by a live `set_storyboard_reference`). The board does not decide decomposition —
it *executes* the plan `video-planning` produced.

The Storyboard is the **execution / orchestration** layer: which card, which spend, what lands on the
timeline. It does NOT contain generation craft — at the "generate the take" step it calls
DOWN into the craft / mechanics skills:

- **`ai-asset-generation`** — produce ONE asset: pick provider/model, read its schema,
  disclose cost, run + poll, import the file (+ provenance), plus the universal generation
  invariants (no in-video text; native audio on). The call + save layer for both a card's
  keyframe image and its clip.
- **`realistic-image-generation`** — the craft of making a card's KEYFRAME image good
  (gpt-image-2 picker, anti-AI-look tokens, selfie/demographic templates, anatomy validation).
- **`physical-action-video`** — manipulation-beat craft (FLF-first, prompt decomposition,
  model-escalation ladder, editorial fallback) when a card's clip is a physical action.
- **`ai-video-models`** — per-engine prompt grammar (Seedance / Veo / Kling): token order,
  motion language, FLF, duration caps.
- **`ugc-craft`** — UGC genre craft: pacing, natural-motion, skin-realism, character
  consistency, clip-duration, forbidden words (loaded by the UGC flow).
- **`voiceover-production`** — generation-time audio policy: native audio on, multi-clip
  voice carry via `@Audio1`.

A card's keyframe + clip are *authored* on the board (`start_frame`, clip params) and
*produced* by those skills. The board owns the workflow; they own the craft.

## Related

- The schema-cache tools (`get_model_schema_cache` / `save_model_schema_cache` /
  `invalidate_model_schema_cache`) back the generation spec — populate before
  `set_storyboard_generation`.
- `ai-asset-generation` — keyframe image craft (gpt-image-2 default, anatomy rules).
- `ai-video-models` / `stitching-multi-clip` — clip generation + multi-clip consistency.
- `using-character-library` — the character reference carried across keyframes.
- `using-snapshot-draft` — storyboard edits land in the draft; commit/discard apply.

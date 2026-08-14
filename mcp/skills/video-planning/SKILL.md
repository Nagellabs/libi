---
name: video-planning
description: "Think like a senior video editor BEFORE generating — reverse-engineer a target video into its building blocks and build algorithm, turn it into an explicit reviewable plan, then direct the build through the Storyboard, loading the right craft specialist per block. Resolves three entry modes (extract a plan from a demo video · reuse a saved recipe skill · create a fresh plan) and offers to capture a liked plan as a reusable skill. Loaded BY mimic-video and every creation skill (generic-video, ugc-product-video, music-video-creation) — the planning/director layer ABOVE the Storyboard. Not a standalone entry point."
when_to_use: Before building or recreating ANY multi-block video — invoked by mimic-video (extract a plan from the source) and by the creation skills (plan the brief into blocks) before the Storyboard is built. Triggers indirectly whenever a video is about to be planned or recreated.
tags: [planning, generation, recreate]
---

# Video Planning (the director)

You are a **senior video editor**, not a clip vending machine. Before any money is spent, you
understand what the target video *is* — its scenes, structure, and the underlying **build
algorithm** — and you turn that into an explicit, reviewable **plan of building blocks**. Then you
**direct** the build of those blocks through the Storyboard, loading the right specialist per block.

This is the **planning / director layer ABOVE the Storyboard**. The Storyboard is the *execution*
mechanism (one card per block, takes, live references); this skill decides the *decomposition and
sequencing*. The craft skills (`realistic-image-generation`, `physical-action-video`,
`ai-video-models`, `voiceover-production`, …) are your **specialist team**; you are the director who
sequences them. You generate NOTHING directly — you plan, then hand each block to the board.

The detailed decision table + a fully worked example + the block→card mapping live in
[`prompts/build-breakdown.md`](prompts/build-breakdown.md) — read it before authoring a plan.

## Why this exists

The failure mode this prevents: jumping from a one-line brief (or a raw `video-analysis`) straight
to generating clips, with no editorial decomposition — so the user has to hand-guide every clip and
the result has no coherent structure. A real editor first answers "what are the pieces, where does
each come from, and how do they fit together," then builds. So do you.

## Step 1 — Resolve the entry mode

Decide which of three modes you are in, then produce ONE artifact: an ordered **block breakdown**.

- **Extract (a demo / source video exists).** Run `video-analysis` on the source (and
  `audio-analysis` only if it has meaningful speech). Then **reverse-engineer the build algorithm**:
  not a shot-by-shot transcription — the *recipe* a creator would follow to make a video like this.
  (This is the step `mimic-video` hands you.)
- **Reuse (a saved recipe exists).** Look for an existing **recipe skill** — a "how to make this
  kind of video" skill captured from a past build (see Step 5). If one matches the request, adopt
  its block template, model choices, and style-inheritance pattern instead of re-deriving. Skills
  are auto-discovered by description; actively check for a genre/recipe match before deriving fresh.
- **Create (no demo, no recipe).** Author a fresh plan from the user's brief.

## Step 2 — Decompose into building blocks (think like an editor)

Break the video into **building blocks** — the smallest set of footage units that compose the whole.
For EACH block, decide and record (full table + example in `prompts/build-breakdown.md`):

1. **Content** — what happens / what is said in this block.
2. **Source** — do we already have footage · must we source it · or generate it with AI? If
   generate: which kind (talking-head, b-roll, VFX, physical action, …).
3. **Combine vs. split** — one generation covering several beats, or separate clips? **Default to the
   FEWEST model-max multi-beat clips** (the `ugc-craft` clip-duration rule): a ~30s video ≈ 2 clips,
   never one-clip-per-source-shot. Split only when beats genuinely need different generations.
4. **Style inheritance** — if split, what this block inherits from the previous one (character,
   palette, location, lighting) and *how*: a live `reference_video` link to the prior card's take +
   the carried character reference image. This is how a downstream VFX/angle block keeps the look of
   the block before it.
5. **Defer to post** — captions, lower-thirds, music: these are overlays / audio clips added AFTER,
   never generated into the clip.

The canonical worked example (talking-head → VFX insert → second angle → captioned outro), with the
exact source/combine/inherit calls, is in `prompts/build-breakdown.md`.

## Step 3 — Present the plan, get approval (free, pre-spend)

Present the block breakdown to the user as a short numbered plan: for each block, its content, its
source/generation decision, and what it inherits. This is the cheap review gate BEFORE any spend.
Revise on feedback. Record the approved editorial intent in the Storyboard **overview**.

## Step 4 — Map blocks to the Storyboard and direct the build

Hand the approved plan to **`using-storyboard`** — the backbone is unchanged. Map it:

- **1 block → 1 card.** A combined multi-beat block is ONE card (beats are in-prompt jump cuts). A
  split-with-inheritance pair is two cards joined by `set_storyboard_reference` (`reference_video`).
- **Carry the target aspect onto every card.** Record the plan's target orientation/aspect once and
  set each card's clip (and keyframe) `aspect_ratio` to it. In *extract* mode that target is the
  **source's actual aspect** (read it from the analysis — a 1920×1080 source is landscape; don't
  assume a platform's typical orientation). A recreation that flips the source's orientation is a
  faithfulness failure.
- **Direct sequentially by default.** Work cards in plan order; for each, load the right specialist
  (the `using-storyboard` layer-map lists them) and run the board's
  schematic → generation-spec → generate → validate → `select_storyboard_take` loop.
- **Independent-block fan-out (optional, opportunistic).** When ≥2 blocks share NO style/continuity
  dependency (e.g. three unrelated b-roll inserts), you MAY work them as parallel subagent tasks and
  then synthesize. If parallel dispatch is unavailable in this surface, fall back to sequential —
  the plan executes identically either way. **Never fan out blocks that inherit from each other**
  (a style chain must run in order so each link's take exists before the next references it).

## Step 5 — Offer to capture the plan as a reusable skill (consent-first, once)

After a successful build, if the plan represents a **meaningfully repeatable recipe** (a genre +
block template the user is likely to want again), OFFER — at most once, only with consent — to save
it as a **user skill** via `libi.add_skill`. The captured recipe must contain:

- **Genre triggers** — when a future agent should reach for this recipe.
- **The block template** — the ordered blocks with their source/combine/inherit decisions.
- **Model choices** — which models per block kind, and why.
- **The style-inheritance pattern** — how continuity is carried (reference links + character ref).

This is the read-side payoff of Step 1's "reuse" mode: a liked plan becomes a recipe future agents
auto-discover, so the user never re-guides this kind of video by hand. Do not capture trivial or
one-off plans. Follow the self-improvement consent rules in the agent instructions.

## Cross-skill references

- `video-analysis` / `audio-analysis` — source understanding for the *extract* mode.
- `using-storyboard` — the execution backbone the plan maps onto (this skill is the layer above it).
- `ugc-craft` — the clip-duration / combine-vs-split methodology (the fewest model-max clips rule).
- `mimic-video` — the recreate dispatcher that calls this skill to extract a plan.
- The specialist team: `realistic-image-generation`, `physical-action-video`, `ai-video-models`,
  `ai-asset-generation`, `voiceover-production`, `stitching-multi-clip`.

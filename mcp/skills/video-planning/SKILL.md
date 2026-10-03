---
name: video-planning
description: "Break a source video or a brief into building blocks (source vs AI, combine vs split, style inheritance) and a reviewable plan before anything is generated. Loaded by mimic-video and the creation skills; also use when the user asks for a plan or breakdown of a video before it is built. Generates nothing."
tags: [planning, generation, recreate]
---

# Video Planning (the director)

Think like a senior video editor, not a clip vending machine. Done looks like: the user has seen and approved an ordered plan of building blocks, each with its source and its continuity, before any money is spent, and that plan is written into the storyboard overview so the build follows it.

This is the planning layer above the Storyboard. The Storyboard (`using-storyboard`) executes: one card per block, takes, live references. This skill decides the decomposition and the order, and generates nothing. The failure it prevents is going straight from a one-line brief, or a raw `video-analysis`, to generating clips: the user then guides every clip by hand and the result has no structure. A real editor first answers what the pieces are, where each comes from and how they fit.

[`prompts/build-breakdown.md`](prompts/build-breakdown.md) has the decision table and a worked example; read it before writing a plan.

## Resolve the entry mode

Produce one artifact in any mode: an ordered block breakdown.

- **Extract** (a demo or source video exists). Run `video-analysis` on it, and `audio-analysis` if it has meaningful speech. Then reverse-engineer the build algorithm: not a shot-by-shot transcription but the recipe a creator would follow to make a video like it. `mimic-video` hands you this case.
- **Reuse** (a saved recipe exists). Check the user's skills for a recipe captured from an earlier build of this kind of video; if one matches, adopt its block template, model choices and continuity pattern instead of deriving them again.
- **Create** (neither). Author a fresh plan from the brief.

## Decompose into blocks

A block is the smallest unit of footage that composes the whole. For each one, record:

1. **Content**: what happens or is said.
2. **Source**: footage we already have, footage to source, or AI generation, and if generated, what kind (talking head, b-roll, VFX, physical action, graphic).
3. **Combine vs. split**: default to the fewest clips, each as long as the model's own per-clip max allows with its beats as jump cuts inside the prompt. A faithful 30-second recreation is about two clips, never one per source shot. Split only when the generation itself has to change (a different subject, an angle the model cannot cut to, VFX, a physical action needing its own craft). `ugc-product-video` owns the reasoning.
4. **Style inheritance** (when split): what the block takes from the previous one (character, palette, location, lighting) and how: a live `reference_video` link to the previous card's take plus the carried character reference image.
5. **Deferred to post**: captions, lower-thirds, titles and music are overlays and audio clips added afterwards, never generated into a clip.

## Present the plan, get approval

Show a short numbered plan: for each block, its content, source decision and inheritance. This is the free review gate before any spend. Revise on feedback, then record the approved editorial intent in the storyboard overview.

## Hand it to the Storyboard

Give the approved plan to `using-storyboard`:

- **One block, one card.** A combined multi-beat block is one card; a split-with-inheritance pair is two cards joined by `libi.set_storyboard_reference` (`reference_video`).
- **Carry the target aspect onto every card.** In extract mode the target is the source's actual aspect, read from the analysis (a 1920x1080 source is landscape whatever platform it came from); a recreation that flips orientation is unfaithful.
- **Work in plan order.** Blocks that inherit from each other must run in sequence so each link's take exists before the next references it. Blocks with no dependency (three unrelated b-roll inserts) may be worked in parallel when your surface can run subagents; the plan executes the same either way.
- Load the right specialist for each block as it comes up: the engine and physical-action references in `video-generation-craft`, `ai-asset-generation` for the call, `stitching-multi-clip` when source footage is reused.

## Offer to keep a plan that worked

After a successful build, if the plan is a repeatable recipe the user is likely to want again, offer once, and only with their consent, to save it as a user skill with `libi.skill` action `add`. The recipe holds the genre triggers (when to reach for it), the ordered block template with its decisions, the model choice per block kind and why, and the continuity pattern. This is what makes Reuse mode work next time. Do not offer it for a trivial or one-off plan.

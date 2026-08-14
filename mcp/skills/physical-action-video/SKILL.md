---
name: physical-action-video
description: "Make hard physical-action / manipulation video beats survive generation — applying, peeling, pressing, pouring, gripping-and-releasing, twisting, writing, cutting. Owns the FLF-first (first-last-frame) approach, prompt decomposition (3–5 one-verb sub-steps, object anchoring, affordance pre-conditions, frame-relative direction), the model-escalation ladder, the editorial before/after fallback, and the levers that keep isolated clips looking like ONE video. Loaded BY ugc-product-video / generic-video / production-routes when a beat manipulates an object. NOT a standalone entry point."
when_to_use: Loaded by a creation/storyboard flow when a beat involves a character physically manipulating an object (the motion, not just presence). Frame analysis alone cannot validate these — the defense is prompt decomposition + FLF + a model ladder. Not triggered directly by user requests.
tags:
  - generation
  - reference
---

# Physical-Action Video (manipulation-beat craft)

This is the **video-craft** layer for the hardest beats: a character physically interacting
with an object — filling, opening, pouring, applying, twisting, gripping-and-releasing, writing,
cutting, lifting. Frame analysis CANNOT validate these (each frame in isolation is plausible; the
error is in the *motion*). The defense is BOTH (a) explicit prompt decomposition AND (b)
first-last-frame generation + a model-escalation ladder + post-generation video-understanding
verification.

The Storyboard owns the *workflow* (which card, when to spend); `ai-asset-generation` owns the
*call + save mechanics*; `realistic-image-generation` owns the *keyframe images*. This skill owns
*how to make a manipulation beat not fall apart.* Apply it whenever a beat is a physical
manipulation (`physicalActionVerification` beats in `ugc-product-video`).

## Stage 4.5 video-understanding question bank (cross-reference)

When the beat is flagged `physicalActionVerification: true`, the agent's Stage 4.5 video-understanding pass uses a TWO-PART question set:
1. **Universal physical-plausibility checklist** (6 fixed questions, always asked — covers liquid source, object permanence, gravity, grip stability, spatial geometry, on-screen text).
2. **Beat-specific questions** (2–4 generated from the beat's decomposition sub-steps).

See `ugc-product-video` Stage 4.5 for the canonical question text. The decomposition you write here IS the source-of-truth for the beat-specific questions later — make sure every sub-step in your decomposition has a clear failure-state the verifier can probe.

## Prompt decomposition (physical-action)

When the generation involves a character interacting physically with an object — filling, opening, pouring, applying, twisting, gripping-and-releasing, writing, cutting, lifting — frame analysis CANNOT validate the result (each frame in isolation is plausible; the error is in the motion). The defense is BOTH (a) explicit prompt decomposition AND (b) post-generation video-understanding verification (see Stage 4.5 in `ugc-product-video`).

**Background:** the rules below are sourced from a 2026-05-27 deep-research pass across Veo 3.1 / Sora / Kling / Runway / Hunyuan vendor docs and trusted community knowledge. Full citations and worked examples live at `docs-local/superpowers/notes/2026-05-27-physical-action-prompting-research.md`.

### Template spine (universal across SOTA video models)

These patterns work across models based on convergent evidence from multiple independent sources.

**3.1 Multi-Step Decomposition (3–5 sub-steps per action)** — Break a physical action into 3–5 discrete beats, one verb per beat. Evidence converges from four independent sources: Google Cloud Blog timestamp workflow (2–4 beats per 8-second clip), createxflow.com Sora guide (one action per shot), veed.io Kling guide (three-action maximum per 2.6 clip), and Hunyuan handbook (sequential connector syntax). More than 5 sub-steps exceeds the model's context for maintaining object identity. Fewer than 2 leaves affordance states ambiguous. (source: https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1, https://createxflow.com/sora-2-prompt-engineering/, https://www.veed.io/learn/kling-ai-prompting-guide, https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5/blob/main/assets/HunyuanVideo_1_5_Prompt_Handbook_EN.md)

**3.2 Object Anchoring (Relationship, Not Just Presence)** — Describe objects in terms of their spatial relationship to the subject's body or other objects. Example: "glass rim positioned near lips, visible liquid inside glass." Example: "she holds the selfie stick (that's where the camera is)." Anchors give the model a constraint it can carry across frames — the primary defense against phantom insertion/removal. (source: https://www.veed.io/learn/kling-ai-prompting-guide, https://invideo.io/blog/google-veo-prompt-guide/)

**3.3 Motion-Verb Specificity (Direction + Axis + Termination)** — Replace result-state verbs with direction + axis + termination. "trudges forward, each step pressing deep into snow" beats "walks." "twists counterclockwise until it separates" beats "opens." For physical actions, always include the termination: "cap lifts free and is placed on the counter" rather than "opens the cap." (source: https://medium.com/@creativeaininja/how-to-actually-control-next-gen-video-ai-runway-kling-veo-and-sora-prompting-strategies-92ef0055658b, https://www.veed.io/learn/kling-ai-prompting-guide)

**3.4 Affordance Pre-Conditions** — Explicitly declare the initial state of every object before any motion verb fires. List object states in a continuity block: `"cap: fully removed"`, `"bottle: empty, transparent, cap-free"`. This directly prevents violated-affordance failures. For physics-heavy actions, embed physics constraints in the same block: "water behaves naturally, falling downward with gravity." (source: https://developer.tenten.co/veo-331-pro-json-prompting-step-by-step, https://superprompt.com/blog/openai-sora-2-complete-guide)

**3.5 Camera-Relative Direction Language** — Use frame-relative rather than body-relative directionals. Example: "hand reaches from the right side of the frame... leaves from the bottom." Example: "continues from screen-left." This is stable regardless of how the model interprets the character's orientation. (source: https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5/blob/main/assets/HunyuanVideo_1_5_Prompt_Handbook_EN.md, https://skywork.ai/blog/multi-prompt-multi-shot-consistency-veo-3-1-best-practices/)

**3.6 Continuity Hooks Between Clips** — Begin each subsequent clip prompt by referencing the end state of the prior clip. Use match-action cues like "subject continues holding X." Export the last clean frame and use it as a reference image for the next generation. Use I2V with the last frame as a start image for seamless object-state propagation. (source: https://skywork.ai/blog/multi-prompt-multi-shot-consistency-veo-3-1-best-practices/, https://magichour.ai/blog/how-to-keep-characters-consistent-in-ai-video, https://www.veed.io/learn/kling-ai-prompting-guide)

### Veo 3.1 / Veo 3 specific patterns

Veo 3.1 weights early tokens heavily; interprets prompts cinematographically; supports timestamp-segmented prompting and "Ingredients to Video" reference-image workflow; no official negative-prompt field. (source: https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1, https://deepmind.google/models/veo/prompt-guide/, https://invideo.io/blog/google-veo-prompt-guide/)

**Timestamp decomposition** (officially documented, Google Cloud Blog) — Use bracket-delimited timestamp segments, each containing one shot and one action:
```
[00:00-00:02] Close-up: woman's right hand unscrews the matte white cap; cap fully removed and set on counter.
[00:02-00:05] Medium shot: she tilts the open bottle under the running faucet, water visibly filling the interior.
```
Each bracket = one shot + one action. Prevents the model from resolving two incompatible states simultaneously. (source: https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1)

**Action-first sentence placement** — Structure: `[SHOT] + [SUBJECT] + [ACTION] + [STYLE] + [CAMERA] + [AUDIO]`. Veo weights early words most heavily. (source: https://developer.tenten.co/veo-331-pro-json-prompting-step-by-step)

**Object pre-state continuity block** — Before any motion verb: `"cap: fully removed"`, `"bottle: empty, transparent, cap-free"`. Establishes affordance precondition. (source: https://developer.tenten.co/veo-331-pro-json-prompting-step-by-step)

**One dominant force per prompt** — Avoid stacking multiple actions in one sentence. Concurrent actions degrade into visual artifacts. (source: https://invideo.io/blog/google-veo-prompt-guide/)

**Empirically reported phrasings for Veo 3.1:** "lifting the bottle with her right hand" (anchors hand); "motion should feel deliberate and resolve cleanly at the end" (prevents over-run); "maintain consistent lighting tone throughout" (cross-shot hook). (source: https://invideo.io/blog/google-veo-prompt-guide/, https://ltx.studio/blog/veo-prompt-guide)

### Banned phrasings (verified to trigger failures)

| Pattern | Failure Mode |
|---|---|
| Concurrent vague actions: "she opens the bottle and pours water while talking" | Affordance state never resolves; cap may be simultaneously on and off. (source: https://invideo.io/blog/google-veo-prompt-guide/, https://createxflow.com/sora-2-prompt-engineering/) |
| Conflicting affordance: "twists the closed cap while pouring water" | Direct violated-affordance failure — contradictory physical states resolved randomly per frame. This is the canonical Veo 3.1 failure mode. (source: research §1.1) |
| Generic spatial reference: "she picks it up" with no stated hand or position | Grip-switch between frames. Fix: "lifts with her right hand from the counter." (source: https://www.veed.io/learn/kling-ai-prompting-guide, https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5/blob/main/assets/HunyuanVideo_1_5_Prompt_Handbook_EN.md) |
| Open-ended motion without termination: "water flows into the bottle" | Kling: generation hangs at 99%. All models: duration-fill artifacts, escalating physics degradation. (source: https://www.veed.io/learn/kling-ai-prompting-guide) |
| Exact counts for extremities: "five fingers wrap around the bottle" | Duplication/merging artifacts. Veo 3.1 struggles with precise counts; never specify individual finger counts in close-ups. (source: https://ltx.studio/blog/veo-prompt-guide) |
| Prompt above 400 characters | Unpredictable element prioritization — model may deprioritize the action state in favor of lighting description. (source: https://fal.ai/learn/devs/veo3-prompt-guide-master-google-video-generation) |
| Abbreviating object name across clips: "blue aluminum CamelBak bottle" → "the bottle" | Object reinterpretation — model may treat it as a new object and drift appearance. (source: https://createxflow.com/sora-2-prompt-engineering/, https://magichour.ai/blog/how-to-keep-characters-consistent-in-ai-video) |
| Requesting 8-second clip for a 2-second action | Duration-fill artifacts — model invents continuation that contradicts the stated action. (source: https://venice.ai/blog/the-complete-guide-to-ai-video-prompt-engineering) |

### Worked example — "filling a water bottle"

**BAD prompt (triggers violated-affordance + duration-fill):**
> "A woman fills her water bottle at the kitchen faucet."

**Why it fails:**
- No affordance pre-condition: the model doesn't know whether the cap is on or off before the action begins, so it resolves this per-frame. On the frame the model "decides" to show water going in, the cap may still be visually present from the prior frame's prediction, producing the exact user-witnessed artifact.
- No motion-verb specificity: "fills" is a result state, not a motion sequence. The model is forced to interpolate the intermediate steps (removing the cap, positioning the bottle, turning on the faucet) without instruction, and it may generate them in the wrong order or skip them.
- No termination: the clip will run until the time limit with indeterminate water-filling behavior.
- No hand/object anchoring: the grip, the bottle's orientation, and the faucet's position are all unconstrained.

**GOOD prompt (Veo 3.1 timestamp format):**
> `[00:00-00:02] Close-up from the front: a woman's right hand unscrews the matte white cap from a transparent plastic water bottle; the cap is fully removed and visible in her palm. The bottle is empty and cap-free. Natural overhead kitchen light. Slow, deliberate motion.`
>
> `[00:02-00:04] Medium shot: she places the white cap on the counter to her left, then positions the open mouth of the bottle directly under the running faucet. Water visibly enters the bottle interior from above. Her left hand steadies the bottle from below. Faucet running, water sound.`
>
> `[00:04-00:06] Static medium shot: the bottle fills to approximately three-quarters full. She tilts the bottle slightly upright and turns off the faucet with her right hand. The cap remains on the counter. Motion settles to stillness.`

**Why it succeeds:** (1) "cap is fully removed and visible in her palm" fires *before* any pour verb — violated-affordance failure cannot occur. (2) Each beat has one action. (3) The cap gets a named location (counter, left side); the bottle gets a supporting hand; the faucet gets a relationship to the bottle mouth. (4) Every motion verb includes direction and termination. (5) Each beat references the prior beat's end state. (6) Three 2-second beats match the action scope — no duration over-run. (source: https://docs.superpowers/notes/2026-05-27-physical-action-prompting-research.md §6)

### Sub-step count guidance

Convergent evidence from four independent sources indicates **3–5 sub-steps** as the target range: Google Cloud Blog timestamp workflow (2–4 beats per 8-second clip), createxflow.com Sora guide (one action per shot), veed.io Kling guide (three-action maximum), and Hunyuan handbook (sequential connector syntax).

Rules:
- **Default: 3–5 sub-steps** for most physical interactions.
- **Up to 6 for compound actions** (e.g., open + fill + close + set-down sequence).
- **Fewer than 3 is insufficient** unless the action genuinely has only 1–2 discrete states (e.g., a single pour with no lid removal step). If you have fewer than 3, you probably don't need decomposition — use the standard `ai-asset-generation` Step 7 Veo 3.1 template with motion-verb specificity and a clear termination state instead.
- **Never exceed 5 for a single 8-second clip.** More than 5 sub-steps degrades identity maintenance — the model deprioritizes object consistency in favor of resolving all requested motion states. (source: https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1, https://createxflow.com/sora-2-prompt-engineering/, https://www.veed.io/learn/kling-ai-prompting-guide, https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5/blob/main/assets/HunyuanVideo_1_5_Prompt_Handbook_EN.md)

## FLF-first + model-escalation ladder (mandatory for manipulation beats)

**Background:** the 2026-05-28 nail-wraps QA produced a clip where a press-on
nail strip wiggled and then DISAPPEARED mid-application — the canonical
object-permanence break during fine manipulation. Root cause: the beat was a
fine manipulation, sent text-only to the weakest physics model
(`veo3.1/fast/image-to-video`), with a run-on multi-action prompt and no
end-state pin. Full citations + research:
[docs-local/superpowers/notes/2026-05-28-physical-realism-flf-and-model-ladder.md](../../../docs-local/superpowers/notes/2026-05-28-physical-realism-flf-and-model-ladder.md).

This fires whenever the beat is a physical manipulation (applying, peeling,
pressing, pouring, gripping-and-releasing, etc.) — i.e. `physicalActionVerification`
beats in the `ugc-product-video` skill. Apply ALL of the following, in order.

### A) Default to first-last-frame (FLF), not text-to-video

For a manipulation beat, **pinning the END state is the structural fix** for
"object disappears mid-motion" — the model is forced to *arrive* at the final
state instead of improvising. FLF also sidesteps the timestamp-bracket problem
(see B).

1. Generate a clean **start frame** (the object held millimetres from its
   destination, product large + sharp, anatomy correct) and a clean **end frame**
   (object in its final applied state) via the image model (`realistic-image-generation`
   picker).
2. **Vision-Read both keyframes** and confirm anatomy + product geometry BEFORE
   spending video credits — the output is only as stable as the start frame;
   flaws compound.
3. Generate the clip with the model's first-last-frame mode, describing only the
   *transition*. Default: `fal-ai/veo3.1/fast/first-last-frame-to-video` (same
   $0.10–0.15/s tier as i2v — verify via `get_pricing`).

> **FLF is a capability, surfaced differently per model — always confirm via
> `get_model_schema` before assuming.** Two shapes exist:
> - **Dedicated endpoint:** Veo `fal-ai/veo3.1/fast/first-last-frame-to-video`
>   (and `veo3.1/lite/...`); Kling `fal-ai/kling-video/o1/image-to-video`
>   (start = `@Image1`/first image, end = `@Image2`/last image); Wan
>   `fal-ai/wan-flf2v`.
> - **Parameter on the i2v endpoint:** Seedance `bytedance/seedance-2.0/image-to-video`
>   takes an `end_image_url` (no separate endpoint).
> When picking a model, look for EITHER a `*first-last-frame*` endpoint OR an
> `end_image`/`end_image_url`/second-image input in the schema.

> **Timestamp brackets DON'T work on veo3.1/fast.** The Fast endpoint misparses
> `[00:00-00:02] …` segments as missing-attachment refs and fails
> `no_media_generated`. Timestamp decomposition (above / Veo official guide)
> is a **full-Veo-3.1** feature only. On Fast, use FLF + a single transition
> sentence instead.

### B) Prompt discipline that works WITHOUT timestamp brackets

- **One dominant action per clip.** Multi-action run-on prompts are the
  documented cause of Veo physics breaking. Split compound actions into separate
  clips.
- **Terminating motion verb + explicit end state** ("presses the strip flat onto
  the nail and holds it there").
- **Object-permanence anchor** (verbatim pattern): "the [named object] remains
  visible in her hand and on the nail throughout; product shape and label
  preserved."
- **Tight shot lock** ("macro close-up") so the object can't drift out of frame;
  keep the product large — small objects morph.
- **Surgical negative prompt** (don't over-stuff): `morphing, warping, shifting
  textures, flickering, floating objects, object disappearing, distorted label,
  extra fingers`.
- **Short-clip exception (per-beat only):** for an ISOLATED physical-manipulation
  beat that keeps morphing, a shorter clip (e.g. 4s) has fewer frames and less
  drift. This is a narrow per-beat exception — NOT the default. The default is one
  full-length multi-beat clip (see `ugc-craft` → Clip-duration methodology); do not
  let this shrink the whole ad into many tiny clips.

### C) Model-escalation ladder (escalate only the failing beat — controls cost)

When the beat still fails Stage 4.5 validation after the FLF + prompt fixes,
escalate THAT beat (keep cheap beats on Fast). **The model names below are dated
examples (2026-05), NOT a fixed ranking — discover the current strongest one at
runtime** via fal `recommend_model` / `search_models` / `get_model_schema` /
`get_pricing` (query for "first-last-frame" / "fine object manipulation" /
"hands"), and prefer whatever the provider currently ranks top. Better models
ship every few weeks; never assume a hardcoded id is still best or even present.
**For a known-hard `complex-on-body` beat (see `ugc-product-video` Stage 3),
start at the strong model — do NOT waste two cheap Fast attempts that are
predictably going to morph (that burned ~$1.20 for nothing in QA).**

- **Tier 0:** `fal-ai/veo3.1/fast/first-last-frame-to-video` + the discipline above.
- **Tier 1:** **Kling** start/end frame — best 2026 hands/close-up +
  object-permanence. FLF endpoint: `fal-ai/kling-video/o1/image-to-video`
  (`@Image1` = start, `@Image2` = end); Kling 2.5 Turbo also exposes start/end.
- **Tier 2:** **Seedance 2.0** (ByteDance, newest, strong physics) — FLF via the
  `end_image_url` param on `bytedance/seedance-2.0/image-to-video`.
- **Ceiling:** Sora 2 Pro (physics leader) — only if confirmed live on the
  provider (reported API sunset ~Sept 2026).

Disclose the higher per-second cost before escalating; escalation counts against
`batchCap`.

### D) Editorial fallback (strongest defense — use when generation keeps failing)

If a beat fails the ladder, DON'T keep burning credits. Restructure THAT beat so the model never has to render the impossible instant (a before/after hard cut, a cutaway). This per-beat editorial split is a LAST-RESORT fallback for an un-renderable manipulation beat — NOT the default ad structure. The default remains ONE full-length multi-beat clip (see `ugc-craft` → Clip-duration methodology); do not let this fallback fragment the whole ad:

- **Before / after as two clips, hard-cut the in-between** (object near
  destination → cut → object already applied).
- **Cutaway to a hands-only insert** / cut on action.
- **Composite a real product photo** at the reveal via `libi.add_overlay({ kind: "image" })`
  so the product is never model-rendered at the critical frame.

Surface this option to the user when Tier 1–2 don't converge.

### E) Keeping isolated / independent clips looking like ONE video

Isolating a manipulation beat (or using the editorial before/after split) means
you now have multiple independently-generated clips instead of one continuous
extend chain. The extend API gives seamless continuity for free because the model
*remembers* the previous frame; independent clips have no memory, so you engineer
the continuity. Six levers, in order of impact:

1. **Frame-chaining (highest impact).** Extract the LAST frame of the previous
   clip (`libi.generate_thumbnails({ fileId, atTime: <duration-0.05>, count: 1 })`)
   and feed it as the **start image** of the next clip — as the i2v start image,
   or as the FLF **start** frame. The seam vanishes because the next clip begins
   on the exact pixel the previous one ended on. This is the manual version of
   what extend does automatically.
2. **Same character reference image on every clip** — locks face, hair, wardrobe,
   identity so the person isn't re-invented each clip.
3. **Repeat the descriptors verbatim** across clips: same lighting phrase, same
   background, same color grade, same wardrobe, and the **named product**
   ("the matte-white nail box", never abbreviated to "the box" — abbreviation
   makes the model treat it as a new object and drift its appearance).
4. **Same model + resolution + fps + aspect ratio** for every clip — keeps them
   visually matched AND lets `libi.concat_videos` stream-copy them without a
   re-encode seam.
5. **Editorial cuts as cover.** A deliberate HARD CUT between beats reads as
   normal editing, not a glitch — so small residual mismatches *at a cut* are
   invisible (the same mismatch mid-shot would scream "AI"). Cut exactly at the
   impossible moment.
6. **Product-grid reference image** (one image showing the product from several
   angles, consistent lighting/scale) wherever a clip renders the product, so it
   stays on-model.

After the clips are generated + validated, place them on the timeline as SEPARATE
per-beat scenes in order — under a storyboard flow each is a card's take
(`libi.select_storyboard_take`); do NOT concatenate into one preview file. The
editor's playback engine smooths the clip-boundary seams, and separate scenes keep
each beat independently editable (see the `stitching-multi-clip` skill). The
`ugc-product-video` Path E flow is the worked example of this loop.

> **Tool inventory for this step** (so you know what's available): image gen
> (`realistic-image-generation` picker) for keyframes; `…/first-last-frame-to-video`
> endpoints for FLF; `recommend_model`/`get_model_schema`/`get_pricing` to find + price the
> ladder models; `libi.generate_thumbnails` for last-frame extraction;
> `libi.concat_videos` to stitch; `libi.add_overlay({ kind: "image" })` for a real-product
> composite; `fal-ai/video-understanding` for the physics-QA pass (Stage 4.5).

## Related

- `ai-asset-generation` — the call + save mechanics (and the universal no-text / native-audio rules).
- `realistic-image-generation` — the FLF start/end keyframes this skill animates.
- `ai-video-models` — per-engine prompt grammar (Seedance / Veo / Kling).
- `ugc-craft` — clip-duration methodology (one full-length multi-beat clip is the default; the
  editorial split here is a last-resort per-beat fallback, not a license to fragment).
- `using-storyboard` — owns the card/take workflow these clips are placed through.

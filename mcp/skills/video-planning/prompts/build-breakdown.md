# Build breakdown — the decision table + a worked example

Use this when authoring a plan in `video-planning` Step 2. It expands the per-block decision
framework and shows the canonical worked example end-to-end.

## The per-block decision table

For every building block, fill in all five columns. Keep it terse — this is the editor's shot
breakdown, not prose.

| Column | Question | Options / how to decide |
|---|---|---|
| **Content** | What happens / what is said? | One line. The spoken line, the action, or the visual. |
| **Source** | Where does the footage come from? | `have` (a file already on the piece) · `source` (download / user provides) · `generate` (AI). If generate, tag the KIND: talking-head · b-roll · VFX · physical-action · graphic. |
| **Combine vs. split** | One generation or several? | Default: the **fewest model-max multi-beat clips**. Combine consecutive beats that share subject + setting into ONE clip (in-prompt jump cuts). Split only when a beat needs a different model, a different subject, or VFX the talking model can't do. |
| **Inherit** | What does this block carry from the previous? | If split: `reference_video` live link to the prior card's take (motion/scene continuity) + the carried character reference image (identity) + restate palette/location/lighting in the prompt. If combined or independent: none. |
| **Defer** | What is added in post, not generated? | Captions, lower-thirds, titles → text overlays. Music bed / SFX → audio clips. Never bake these into the generated clip. The music bed itself carries a **source decision** in extract/recreate mode — reuse the original (`libi.extract_audio` from the source + attach) vs generate a new track in the same vibe — owned by `music-creation` Stage 0.5; surface it, don't silently default. |

### The combine-vs-split heuristic (the most common mistake)

- **Combine** when beats are the same person/scene continuing: "she greets camera, then holds up the
  product, then smiles" = ONE talking-head clip with jump-cut beats.
- **Split** when the generation itself must change: a VFX shot, a different location/angle the model
  can't jump to cleanly, a different subject, or a physical-action beat that needs FLF craft.
- A faithful ~30s recreation is ≈ 2 clips, not 8. Mapping one source shot to one generation is the
  failure this rule exists to stop (see `ugc-craft` clip-duration methodology).

## Worked example — "talking-head → VFX → second angle → captioned outro"

Source video (or brief): a creator talks to camera, it cuts to an AI VFX shot, then to a second
angle, and the final beat has captions on screen.

Editor's reading — **four blocks**, NOT four equal clips:

| # | Content | Source | Combine/split | Inherit | Defer |
|---|---|---|---|---|---|
| 1 | Creator to camera: "You won't believe what this does…" | generate · talking-head | one clip | — (first block; establishes the look) | — |
| 2 | VFX: product transforms / energy burst | generate · VFX | split (VFX ≠ talking model) | `reference_video` → block 1's take **+ same character ref** so colors/location/style carry | — |
| 3 | Second angle: creator reacts | generate · talking-head | split (new angle) | `reference_video` → block 2 (or 1) + same character ref | — |
| 4 | Outro line, on-screen captions | reuse block 3 OR short generate | — | character ref | **captions = text overlays added after**; music bed = audio clip (reuse original or generate — `music-creation` Stage 0.5) |

Why this is the right decomposition:
- **Block 2 splits from block 1** because a VFX transformation is a different generation than a
  talking-head — but it must **inherit** block 1's style, so it takes a live `reference_video` link
  to block 1's selected take *plus the same character reference image*. That is exactly the user's
  "the VFX should get a sketch of how it looks AND the first character video so it inherits the same
  style, colors, scene/location."
- **Captions are deferred** — block 4's text is a text overlay, not generated into the clip
  (universal "no in-video text" invariant).
- **Four blocks → four cards** on the Storyboard, with `set_storyboard_reference` links 1→2→3 for
  continuity. If blocks 1 and 3 were truly independent (different scenes, no carried look) they could
  be directed in parallel; here they form a style chain, so they run in order.

## Block → Storyboard card mapping (handing off to `using-storyboard`)

- Each block becomes one `libi.add_storyboard_card` call (`role`, `promptFragment`, `durationSec`,
  `camera`, `voiceover` from the block).
- A **combined** multi-beat block stays ONE card; put the beats as in-prompt jump cuts.
- A **split-with-inheritance** pair becomes two cards joined by
  `libi.set_storyboard_reference({ paramKey: "reference_video", fromCardId })` and the SAME character
  reference image set as the keyframe on both.
- Write the overall editorial intent into the first card's `overview`.
- From here, `using-storyboard` owns the schematic → generation-spec → take/select mechanics
  unchanged.

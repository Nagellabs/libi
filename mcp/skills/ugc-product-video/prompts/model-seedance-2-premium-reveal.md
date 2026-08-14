<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling (ai-asset-generation flow, fal-ai model ids, libi.upload_file). -->

# Premium product reveal — Seedance 2.0

**Use when:** a dramatic, dark-background product launch — hero announcements,
new-model reveals, "introducing the next generation" content. No person on
screen, no spoken dialogue. The product floats in a black void with dramatic
lighting, slow camera moves, premium material close-ups, and a text-driven
narrative.

**Read first:** the Seedance 2.0 platform guide from the **`ai-video-models`** skill
(`model-seedance-2` — platform rules) and [forbidden-words.md](forbidden-words.md) — for this
style use `dramatic` / `premium`, never `cinematic`.

## What defines this style

Everything is stripped away except the product and dramatic text. The frame is
true black void — no environment, no lifestyle, no person. The product emerges
from darkness through lighting that catches metal, glass, or texture. The power
comes from **restraint and revelation**: each beat reveals slightly more — a new
angle, a new detail, a new text line that reframes what you're seeing. Pacing is
deliberate and slow; where UGC feels spontaneous and fast, this feels inevitable
and weighty.

## ⚠️ The text tension — read this before you compose

libi's default rule is **no in-video text** (generated text warps and fails Stage
4.5; see the Seedance 2.0 platform guide in the `ai-video-models` skill and
`ai-asset-generation` Step 6.6). But this format's *whole identity* is text-as-narrative.
Resolve it like this:

- **Decorative / motion text** that's part of the reveal rhythm (a phrase
  drifting in behind the product, loosely styled) — the model MAY carry it, since
  it's atmospheric, not a load-bearing claim. Treat any model-rendered text as
  unreliable and possibly garbled.
- **Crisp, load-bearing text** — the product name, the final brand lockup, the
  CTA, any specific claim/number — **prefer a libi `libi.add_overlay({ kind: "text" })`** on a
  held frame. Overlays are pixel-crisp, editable, correctly kerned, and export
  cleanly. The model cannot be trusted to spell a brand name.
- **Recommendation:** compose the clip so the **brand lockup final frame** is a
  clean held hero shot with negative space, then add the lockup + CTA as overlays.
  Let the model handle only loose atmospheric phrases (if any). When in doubt,
  render text in libi, not in Seedance.

The timestamp blocks below still describe text beats — read them as "where text
*appears*", and decide per line whether it's a model atmospheric phrase or a libi
overlay. Always queue the brand name + CTA as overlays.

## The 6 layers

```
 1. VOID STAGE        — the black backdrop and lighting setup
 2. PRODUCT HERO      — what the product looks like, how it's lit
 3. TEXT NARRATIVE    — the story told through text beats (mostly libi overlays)
 4. REVEAL SEQUENCE   — choreography of product angles + camera moves
 5. VARIANT SHOWCASE  — size/color/model comparison (optional)
 6. BRAND CLOSE       — final product name + series lockup (libi overlay)
```

---

### Layer 1: Void stage

True black void (#000000), not dark grey. The product floats in nothingness;
light is the only thing giving the scene dimension.

```
{{DURATION}} premium product reveal video. Pure black background, {{LIGHTING_STYLE}}, {{LIGHTING_DIRECTION}}.
```

| Variable | Options |
|---|---|
| `DURATION` | 15 seconds (use the full duration) |
| `LIGHTING_STYLE` | dramatic rim lighting (default — outlines the product against the void), soft gradient spotlight, hard directional key light, warm amber accent, cool silver edge lighting |
| `LIGHTING_DIRECTION` | from above and behind, side-lit from the left with subtle right fill, backlit with a soft halo around the edges, overhead spot with sharp falloff |

**Key rule:** never describe a *visible* light source (no lamps, windows,
softboxes). The light just exists — the source is invisible. This preserves the
floating-in-void illusion.

---

### Layer 2: Product hero

Describe form, material, and exactly how light interacts with the surfaces.

```
A {{PRODUCT_DESCRIPTION}} — {{MATERIAL_SURFACE}}, {{LIGHT_INTERACTION}}. The product @Image1 is centered in frame, {{SCALE_CUE}}.
```

| Variable | Options |
|---|---|
| `PRODUCT_DESCRIPTION` | name + primary material (brushed-steel speaker, matte black case, frosted-glass bottle) |
| `MATERIAL_SURFACE` | brushed metal with fine grain, polished mirror surface, matte finish absorbing light softly, textured rubber with a subtle sheen |
| `LIGHT_INTERACTION` | rim light catching the edges in a thin white line, reflections sliding across the curve, light pooling in the engraved logo, soft highlights moving across the grain |
| `SCALE_CUE` | filling the lower third, small with black space around it, large and imposing |

**Material → light pairing bank:**

| Material | Best light interaction | Example |
|---|---|---|
| Brushed metal | rim light catching edges, grain visible | aluminum laptop, steel housing |
| Polished / chrome | sharp reflections sliding across the surface | sunglasses, chrome hardware |
| Matte plastic / rubber | soft diffused highlights, no hard reflections | phone case, matte bottle |
| Glass / clear | light refracting through, caustic patterns | perfume bottle, glass jar |
| Fabric / textile | subtle texture under raking light, soft shadows | shoe upper, bag material |

Anchor: "the product @Image1 stays unchanged across every shot."

---

### Layer 3: Text narrative (mostly libi overlays)

Text tells the story, building phrase by phrase. Per the tension note above,
treat the **brand name and CTA as libi overlays**; the model may carry loose
atmospheric phrasing.

**Reveal timing options** (describe the *feel*; libi overlays can match it with
animation, or the model can carry an atmospheric phrase): fades in over 1s
(premium) · snaps on (impact) · types letter by letter (tension) · slides in from
a side (motion) · builds word by word (drama).

**Narrative structures:**

| Structure | Line 1 | Line 2 | Line 3 | Best for |
|---|---|---|---|---|
| **Introduction** | "INTRODUCING" | category claim | product name | launches |
| **Superlative** | bold claim ("Our most X ever") | proof point | product name | upgrades, next-gen |
| **Question** | "What if X?" | answer / feature | product name reveal | innovation |
| **Feature stack** | feature 1 | feature 2 | feature 3 + name | feature-heavy |

**Rules:** max 3 text lines in 15s; each under 8 words (a billboard, not a
paragraph); text sits center frame or upper third, never the very bottom.

---

### Layer 4: Reveal sequence

How the product and camera move. 2–3 distinct views in 15s.

```
{{OPENING_REVEAL}}. {{CAMERA_MOVE_1}}. {{TRANSITION}} — {{CAMERA_MOVE_2}}, {{DETAIL_FOCUS}}. {{FINAL_POSITION}}.
```

**Opening reveal styles:** rise from below (height-oriented products) · fade from
dark (any product, most dramatic) · rotate in (interesting 3D form) · zoom out
from an extreme close-up detail (distinctive textures).

**Camera moves:** slow 360° orbit (shows all sides, premium) · gentle push-in from
medium to close-up (intimacy) · overhead top-down descending (interesting top
profile) · slow pan across surface detail (material quality).

**Key rule:** every move is SLOW — 3–5s minimum each. Use degree adverbs
(slowly, deliberately, gracefully).

---

### Layer 5: Variant showcase (optional)

If the product comes in multiple sizes/colors/models, show them in comparison.

```
{{COMPARISON_LAYOUT}} — {{ITEM_1}}, {{ITEM_2}}, {{ITEM_3}}. {{SIZE_LABELS}} appear below each variant (as libi overlays).
```

Layouts: top-down lineup (size variants) · side-by-side (height/form) · single
swap / morph (color variants, generations).

---

### Layer 6: Brand close (libi overlay)

The final 2–3s. Product name + series + brand lockup — **render this as a libi
overlay on a clean held hero frame**, not as model text.

```
Final frame: the product held at {{FINAL_HERO_ANGLE}} with clean negative space for the brand lockup. (Brand name + CTA added via libi.add_overlay({ kind: "text" }).)
```

---

## Beat structure (15s)

| Beat | Timing | What happens | Text |
|---|---|---|---|
| **1: Tease** | 0–4s | product partially visible / emerging from darkness; slow, dramatic | "INTRODUCING" or bold claim |
| **2: Reveal** | 4–10s | full product visible, camera moves around it — the hero moment | category + key differentiator |
| **3: Lineup + Close** | 10–15s | variant comparison (if any) OR final hero angle; name + lockup | full name + series (libi overlay) |

**Pacing:** no spoken dialogue — music/SFX carry the energy; camera moves slow and
deliberate; text beats drive the rhythm; leave ≥1s of pure black before the end.

---

## Multi-clip strategy — a 3-clip launch series

| Clip | Focus | Text narrative | Product view |
|---|---|---|---|
| **A: Announcement** | "something new is here" | INTRODUCING → bold claim → name | emerging from void, hero angle, lockup |
| **B: Features** | "what makes it special" | feature 1 → 2 → 3 | close-ups on each detail, texture shots |
| **C: Lineup** | "available in X" | "In All-New Sizes" / "X Colors" | side-by-side, variant reveal |

---

## Technical specs

**Lighting:** rim/edge from behind (thin white outline) + soft single-side fill;
no visible source; highlights slide slowly across surfaces as things move.
**Color:** pure black background, true-to-life product colors with slightly
boosted contrast; no color grading beyond high contrast. **Camera:** ultra-clean,
sharp focus (the opposite of UGC), no grain/noise, shallow DoF on close-ups,
smooth dolly/track feel, no handheld shake. **Format:** 9:16 vertical, product
centered with generous black space top and bottom.

---

## Complete template

```
15 seconds premium product reveal video. Pure black background, {{LIGHTING_STYLE}},
{{LIGHTING_DIRECTION}}.

A {{PRODUCT_DESCRIPTION}} — {{MATERIAL_SURFACE}}, {{LIGHT_INTERACTION}}. The product
@Image1 is centered in frame, {{SCALE_CUE}}; it stays unchanged across every shot.

[00:00] {{OPENING_REVEAL}}, rim light illuminating its edges against the void.
[00:04] {{CAMERA_MOVE_1}}, revealing {{DETAIL_1}}.
[00:09] {{CAMERA_MOVE_2}}. {{VARIANT_OR_HERO_ACTION}}.
[00:13] Final frame: the product held at {{FINAL_HERO_ANGLE}} with clean negative
space for the brand lockup.

The camera moves slowly and deliberately throughout — every movement smooth, no
quick cuts or handheld shake. The lighting is dramatic, rim light catching the
product edges against the pure black void. The feel is premium, authoritative,
restrained.

(Text narrative — "{{LINE_1}}", "{{LINE_2}}", and the brand lockup
"{{PRODUCT_FULL_NAME}}" + CTA — added crisply via libi.add_overlay({ kind: "text" }) on the held
beats; the generated video itself carries no readable text.)
```

---

## Worked example — premium wireless earbuds launch

```
15 seconds premium product reveal video. Pure black background, dramatic rim
lighting, light coming from above and behind the product.

A pair of wireless earbuds in a polished graphite charging case — mirror-polished
surface with sharp reflections sliding across the curved lid, a thin cool rim
light tracing the seam, matte earbud stems catching a soft highlight. The product
@Image1 is centered in frame, small with generous black space around it; it stays
unchanged across every shot.

[00:00] The closed case slowly rises into frame from below, rim light catching the
polished edge against the void, the lid still shut.
[00:04] A gentle push-in as the lid opens deliberately, revealing the two earbuds
nested inside, a thin reflection sliding across the chrome hinge.
[00:09] A slow 360 orbit around the open case, one earbud lifting out and rotating
to show the matte stem and the engraved logo pooling light.
[00:13] Final frame: the case held at a slight 3/4 angle, lid open, slowly
rotating to a stop with clean negative space above for the brand lockup.

The camera moves slowly and deliberately throughout — every movement smooth, no
quick cuts or handheld shake. The lighting is dramatic, rim light catching the
polished case and matte stems against the pure black void. The feel is premium,
authoritative, restrained.

(Text narrative — "INTRODUCING", "Adaptive noise cancellation", and the brand
lockup "AERO PRO — Series 3" plus a CTA — added crisply via libi.add_overlay({ kind: "text" })
on the [00:00], [00:09], and [00:13] beats; the generated video itself carries no
readable text.)
```

---

## Adaptation checklist

- [ ] **15 seconds** — single Seedance 2.0 clip (max duration)
- [ ] **Pure black background** — void stage, no environment
- [ ] **Product is the only subject** — described in full detail (material, shape, color)
- [ ] **No dialogue** — zero spoken words; music/SFX carry energy
- [ ] **Text plan resolved** — brand name + CTA + load-bearing claims queued for `libi.add_overlay({ kind: "text" })`; only loose atmospheric phrasing (if any) left to the model
- [ ] **Max 3 text lines** — each under 8 words, reveal timing specified
- [ ] **Reveal sequence** — opening reveal chosen, 2–3 SLOW camera moves
- [ ] **Brand close** — held hero frame with clean negative space for the libi lockup overlay
- [ ] **Lighting** — rim/edge dominant, no visible light source
- [ ] **Timestamps** — 4 blocks covering the full 15s
- [ ] **Platform rules** — 100–260 words, `@Image1`, consistency anchor, motion adverbs, no forbidden words — see the Seedance 2.0 platform guide in the `ai-video-models` skill

<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling (ai-asset-generation flow, fal-ai model ids, libi.upload_file). -->

# Ad formats — selector + named-beat frameworks

Pick the format at Stage 0, then read the matching model formula file before
composing. This is the *creative* axis; the *footage* axis (where clips come
from) lives in `production-routes.md`.

## Format selector

| Format | Use when | Formula file |
|---|---|---|
| UGC selfie | authentic testimonial / reaction, real person on a phone | [model-seedance-2-ugc.md](model-seedance-2-ugc.md) |
| Product hero | no person, product beauty shot, elemental interaction | [model-seedance-2-product-hero.md](model-seedance-2-product-hero.md) |
| Feature walkthrough | demo multiple features, show-don't-tell | [model-seedance-2-feature-walkthrough.md](model-seedance-2-feature-walkthrough.md) |
| Premium reveal | luxury / minimal, void background, text narrative, no dialogue | [model-seedance-2-premium-reveal.md](model-seedance-2-premium-reveal.md) |
| Studio lookbook | styled model, multi-look, voiceover | [model-seedance-2-studio-lookbook.md](model-seedance-2-studio-lookbook.md) |
| Talking-head testimonial | founder / explainer, direct-to-camera | [model-seedance-2-ugc.md](model-seedance-2-ugc.md) (talking-head variant) |

## Named-beat framework

Every UGC ad is a sequence of purpose-driven beats — not a slideshow of pretty
shots. The canonical spine is **Hook → Show → Demo → Result → Verdict**. Each
beat is typically one jump cut.

| Beat | Purpose | Framing | Example action |
|---|---|---|---|
| **Hook** | grab attention in ≤3s | looking into camera | expressive opener, holds product up |
| **Show** | product detail | closer to lens | tilts/turns product, shows label/texture |
| **Demo** | proof of use | extreme close-up | applies/uses product, shows it working |
| **Result** | evidence | mirror / different angle | points at the outcome, before/after |
| **Verdict** | final opinion + CTA | back to opening angle | holds product up, delivers the CTA line |

### How many beats by duration

**Beats are jump-cuts INSIDE one clip, not separate generations** — pick the count
below, then render them within a single full-length clip (see `ugc-craft` →
Clip-duration methodology). Only split into separate clips past the model's
single-clip max.

- **10s** → pick 2–3 of the beats (Hook + one demonstration + Verdict).
- **15s** → use 3–4 beats. 15s is the Seedance 2.0 single-clip max.
- **Longer** → split across clips and stitch (see `production-routes.md`).

Match dialogue to the beat count using the read-aloud word-count→duration method (see [script-craft.md](script-craft.md) → `ugc-craft`) — don't cram five spoken beats into 10 seconds.

## Mandatory silent action beat

**Every video must include at least one non-dialogue demonstration beat** — a
sip, an inspect, a turn-of-the-product, a reaction face, reading the label.
Silent beats feel more authentic, cost zero spoken words, and stop you cramming
dialogue. A talking-head with no silent beat reads as an ad; one silent beat
makes it feel filmed.

## Legacy patterns (format variants / notes)

The five proven UGC patterns map onto the formats above — use them as beat-sheet
starters:

- **Talking head + product** → UGC selfie / talking-head variant. Hook
  direct-to-camera with product in hand → demo one feature → one-sentence verdict
  → CTA.
- **Unboxing** → UGC selfie or Product hero. Sealed package → hands enter → lid
  opens, reveal → lift product out → product in use. Anticipation is the engine.
- **Before / after** → UGC selfie (transformation products). "Before" wide
  context shot of the problem → apply product (closeup) → time-cut transition →
  "after" mirroring the hook composition for a clean A/B.
- **POV demo** → UGC selfie or Feature walkthrough (wearables, tools, gadgets).
  First-person POV, hands enter holding the product → key feature in action →
  wider context shot → result frame.
- **VO-driven b-roll** → Premium reveal or Studio lookbook (softer storytelling).
  Striking environmental shot, no person → product appears in environment →
  subject enters → emotional payoff. VO lives separately, not lip-synced.

## Self-check before you generate

Read the beat list back to yourself. **Does it read as a real ad — hook, story,
payoff, CTA — or a slideshow of disconnected test shots?** If it's the latter,
rewrite. A pretty shot that doesn't advance the sell is dead weight.

No forbidden words anywhere — see [forbidden-words.md](forbidden-words.md).

---
name: ugc-craft
description: "Internal craft reference for UGC video generation: the 9-layer UGC formula, clip-duration methodology, pacing / natural-motion / skin-realism cue banks, character-consistency phrasing, and negative-prompt + forbidden-word lists. Loaded BY `ugc-product-video` and `stitching-multi-clip` — it is NOT a standalone entry point. If the user wants a UGC / product / demo / social video, start from `ugc-product-video` (or `stitching-multi-clip` for a source+AI stitch); do not begin a build from here."
tags:
  - ugc
  - generation
---

# UGC Craft

> **Routing check.** This skill holds only the *craft*. The entry points are
> `ugc-product-video` (full UGC build) and `stitching-multi-clip` (source+AI
> stitch) — they own routing, model selection, snapshot/draft, and all internal
> tooling. If you arrived here directly because the user asked for a video,
> stop and load `ugc-product-video` first, then come back for the craft. The
> *mechanics* of actually running a generation (provider/model pick, prompt
> build, job polling, import) live in `ai-asset-generation`.

This is the model-agnostic knowledge that makes AI UGC feel authentically human.
Apply it through whichever model file the parent skill routed you to (the model
file owns the numeric caps + param specifics; this file owns the craft).

## The 9-layer UGC formula

Stack these in order inside ONE prompt — skip a layer and the output falls apart:

1. **Format header** — duration, style (UGC selfie / walkthrough / lookbook…), device, lighting, angle.
2. **Person** — appearance, **skin texture** (see realism cues), clothing.
3. **Setting** — a lived-in environment with 3–4 specific objects/clutter, not a void.
4. **Product introduction** — exactly how they hold / show / angle the product to camera.
5. **Script beats** — the jump-cut scenes with dialogue + actions (see beat spine + duration).
6. **Tone direction** — personality, energy, and a MANDATORY pacing cue (see pacing).
7. **Edit style** — jump cuts, angle changes, "best bits of multiple takes" feel.
8. **Technical flaws** — camera/lighting/audio imperfections that read as real.
9. **Vibe statement** — one sentence emotional anchor ("the north star").

## Beat spine

Hook → Show → Demo → Result → Verdict.

| Beat | Purpose | Framing |
|---|---|---|
| Hook | Grab attention | Looking into camera; expressive opener, holds product up |
| Show | Product detail | Closer to lens; tilts/turns product, shows label/texture |
| Demo | Proof of use | Extreme close-up; applies/uses, shows texture |
| Result | Evidence | Mirror / different angle; points at the result |
| Verdict | Final opinion | Back to opener angle; final line |

**Beats are jump-cuts INSIDE one clip — they are NOT separate generations.** For a
~10s ad pick 2–3 of these; for ~15s use 3–4. Always include **≥1 silent action
beat** (sipping, inspecting, reacting) regardless of duration.

## Clip-duration methodology (favor longer — this is the headline rule)

> **Headline rule — default to ONE full-length multi-beat clip. Do NOT generate one short clip per beat.**
> The single biggest cause of bad, fast-paced UGC is reading each script beat as its own 3–4s
> generation. On a native multi-beat model (Seedance 2.0 — the default), the Hook / Show / Demo /
> Verdict beats are JUMP CUTS the model renders INSIDE one prompt: a 15s ad is **one ~15s
> generation**, not four 4s clips.
>
> **Rebut the drift myth.** "Short clips avoid identity/motion drift" is true ONLY of a single
> *continuous* long take. It is NOT true of jump-cut beats inside one prompt — those are discrete
> shots the model composes, so they do not drift the way a 15s continuous action would. Never
> fragment "to avoid drift"; put the cuts in one prompt. (A separate clip per beat is justified
> only by the exceptions below, never by drift.)

People speak at ~**2.5 words/second** (~150 WPM) at a natural, unhurried pace
*with pauses*. Size the **whole clip's** spoken script (not each beat) to runtime:

| Spoken words (whole clip) | Target clip duration |
|---|---|
| 1–8 | 4–5s |
| 9–15 | 6–8s |
| 16–25 | 9–12s |
| 26–35 | 13–15s |
| 36+ | split into multiple clips |

**Read every line aloud at a relaxed pace and time it.** If you have to rush, you
have too much — shorten the line, cut filler, or lengthen the clip. Silent beats
cost zero words; lean on them.

**Favor the longest single clip the chosen model can produce.** Reach the target
duration through the model's native clip length or its extend chain — NOT by
fragmenting the ad into many tiny separate generations:

- **Native multi-beat models (e.g. Seedance 2.0):** put the jump-cut beats INSIDE
  one prompt and generate ONE clip at/near the model's max (15s). The model
  renders the cuts itself.
- **Extend-capable models (e.g. Veo extend chain):** one continuous action per
  generation, chained up to the target length → one unified clip.
- **Split into multiple SEPARATE generations only when:** (a) the script exceeds
  the model's single-clip max, (b) 36+ spoken words, or (c) a physical-
  manipulation beat keeps failing and you fall back to the editorial 3–5-clip
  split (`physical-action-video` § Editorial fallback).

**The failure mode to avoid:** reading each script beat as its own 3–4s
generation. That produces fast, incoherent pacing. Beats are cuts within a clip.

**When you DO split (target exceeds the model's single-clip max):** each split clip is
STILL a multi-beat ≤max-length clip. Use the FEWEST clips — about `ceil(target ÷ model max)`
— and pack consecutive beats into each as in-prompt jump cuts. A **30s Seedance ad = TWO
~15s multi-beat clips, NOT eight 3–4s clips.** This applies to RECREATIONS / mimics too:
group the source's shots into the fewest multi-beat clips — NEVER map one source shot to
one clip. (A standalone clip per beat is justified only for case (c) above — a
manipulation beat that keeps failing and falls back to the editorial split.)

## Pacing cues (counter AI fast-speech — MANDATORY)

AI video generators default to unnaturally fast speech. Every tone-direction
paragraph MUST carry an explicit pacing cue. Use phrasing like:
- "pauses between thoughts as if collecting the next word"
- "leaves a beat of silence after each sentence before continuing"
- "speaks at a relaxed, unhurried pace — no rushing"

## Natural-motion cue banks (counter the "frozen mannequin")

AI video defaults to a frozen subject staring at camera. Real people constantly
move. Always include **≥3–4** of these:
- **Eyes:** briefly breaks eye contact, glances down/aside, then back.
- **Head/face:** small tilts, micro-expressions, a half-laugh.
- **Body:** weight shifts, gestures with the free hand, leans in/out.
- **Selfie arm:** slight handheld drift / reframe as if holding the phone.

## Skin-realism cues

Always include **2–3** reality cues (visible pores, fine lines, slight shine,
stray hairs, natural uneven skin tone). Without them AI defaults to airbrushed.
**Do NOT use** `acne / pimples / breakouts / blemishes / rosacea` — real ≠
dermatological.

## Character consistency

- **Use a full-body shot as the hero reference** — gives the model face, hair,
  build, wardrobe, proportions, so every angle stays consistent. A medium
  portrait forces the model to invent the lower half.
- Reference it explicitly: *"the exact same person from the reference image —
  same face, same {hair}, same {eyes}, same {build}, same {clothing}."*
- **Freeze the core description.** Between generations vary only pose / setting /
  framing — small wording changes drift the face.
- Same product reference + repeat the product name verbatim so the product never
  re-invents itself.

## Negative prompts + camera-physics vocabulary

- **Camera physics (use these):** "iPhone 15 Pro front camera, selfie mode",
  "native wide lens (~26mm)", "f/2.2", "subtle edge distortion", "natural micro
  lens flare", "mild luminance grain", "slight rolling-shutter".
- **Always exclude (negative prompt, where the model supports one):** "studio
  lighting, professional photography, stock photo, perfect skin, heavy makeup,
  centered framing, staged, cinematic, LUT, color graded, stabilization,
  subtitles, captions, on-screen text".

## Forbidden words

Never put these in a prompt: `cinematic`, `professional`, `stunning`, `8k`,
`studio`, `perfect`. They pull toward polished stock and away from UGC
authenticity. For premium / product-hero styles, use `dramatic` or `premium`
instead of `cinematic`.

## Brief-capture quick reference

- **Hook:** the first 1–2 seconds — a pattern interrupt, curiosity, or relatable moment.
- **CTA:** the exact words (spoken or on-screen), e.g. "link in bio", "shop the drop".
- **Translate vague adjectives** ("premium", "fun") into visual specifics —
  materials, wardrobe, location, pace. Prefer one paragraph of clear direction
  over a bag of keywords.

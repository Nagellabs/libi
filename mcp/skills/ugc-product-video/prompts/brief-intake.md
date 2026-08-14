<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling (ai-asset-generation flow, fal-ai model ids, libi.upload_file). -->

# Brief intake — six questions before any script

Run this **before** picking a format ([ad-formats.md](ad-formats.md)) or writing
a line of dialogue ([script-craft.md](script-craft.md)). A UGC video built
without a brief becomes a feasible-but-pointless slideshow of test shots. The
brief is what makes it an *ad*.

Ask the user these six. If they answer one vaguely, push for the specific —
don't fill the gap with a guess.

| # | Question | What good looks like |
|---|---|---|
| 1 | **Audience** — who is this for? (one sentence) | "Women 25–35 who already buy retinol and want a gentler swap." Not "everyone." |
| 2 | **Job-to-be-done** — what should the viewer feel or do after watching? | "Tap the link and try the 2-week sample." Not "be aware of us." |
| 3 | **Offer + proof** — product name, one concrete benefit, optional social proof | "Aurora Serum — visibly less redness in 14 days, 4.8★ from 2k buyers." |
| 4 | **Hook** — the first 1–2 seconds: pattern interrupt, curiosity, or relatable moment | "I almost returned this." / "POV: your skincare actually works." |
| 5 | **CTA** — the exact words, if spoken or on-screen | "Shop the drop." / "Comment GLOW for the link." Not "drive conversions." |
| 6 | **Constraints** — length, aspect ratio, platform, banned topics, brand words to avoid | "15s, 9:16, TikTok, never say 'cure'." |

## Translate vague adjectives into visual specifics

If the brief leans on a mood word, convert it before composing. A model can't
render "premium" — it renders materials, wardrobe, locations, and pace.

| Vague | Translate to |
|---|---|
| "premium" | brushed-metal product, neutral linen wardrobe, quiet minimalist room, slow deliberate camera |
| "fun" | bright daylight, quick jump cuts, casual hoodie, an actual laugh in the dialogue |
| "trustworthy" | direct eye contact, unhurried pacing, real skin texture, no music bed |
| "energetic" | handheld movement, faster cuts, gestures with the product, up-tempo delivery |

Watch for forbidden tokens while you do this — see
[forbidden-words.md](forbidden-words.md) (`cinematic`, `professional`,
`studio`, etc. all need paraphrasing).

## Compose, don't keyword-dump

Prefer **one paragraph of clear direction** over a bag of keywords. Name the
subject, setting, camera/motion, lighting, and audio mood as a coherent scene —
that reads far better to a video model than a comma-soup of tags.

## Where the answers go

These six answers feed **Stage 3 (Script)** directly: the hook seeds
[copywriting-angles.md](copywriting-angles.md), the CTA becomes the verdict beat,
the constraints set duration in [script-craft.md](script-craft.md). Record the
brief in the storyboard **overview** (`libi.add_storyboard_card({ overview })`) so it
persists and the rest of the pipeline (and a later re-run) can read it back.

<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling. -->

# Brief intake

A UGC video built without a brief is a feasible but pointless slideshow of test shots; the brief is what makes it an ad. Ask these before picking a format or writing a line, skipping what the user already said. If an answer is vague, push for the specific rather than filling the gap with a guess.

| # | Question | Good looks like |
| --- | --- | --- |
| 1 | **Audience**, in one sentence | "Women 25 to 35 who already buy retinol and want a gentler swap", not "everyone" |
| 2 | **Job to be done**: what should the viewer feel or do after | "Tap the link and try the 2-week sample", not "be aware of us" |
| 3 | **Offer and proof**: product name, one concrete benefit, optional social proof | "Aurora Serum, visibly less redness in 14 days, 4.8 stars from 2k buyers" |
| 4 | **Hook**: the first one or two seconds | "I almost returned this." / "POV: your skincare actually works." |
| 5 | **CTA**: the exact words, spoken or on screen | "Shop the drop." / "Comment GLOW for the link." |
| 6 | **Constraints**: length, aspect ratio, platform, banned topics, brand words to avoid | "15 s, 9:16, TikTok, never say 'cure'" |

Translate mood words into visual specifics before composing, since a model renders materials, wardrobe, locations and pace, not "premium": premium is brushed metal, linen wardrobe, a quiet minimal room, slow deliberate camera; fun is bright daylight, quick cuts, a hoodie, a real laugh; trustworthy is direct eye contact, unhurried pacing, real skin texture, no music bed; energetic is handheld movement, faster cuts, gestures with the product. Check the result against the banned words in [craft](../references/craft.md).

Compose one paragraph of clear direction (subject, setting, camera and motion, lighting, audio mood) rather than a bag of keywords.

The answers feed the script: the hook seeds [copywriting-angles](copywriting-angles.md), the CTA becomes the verdict beat, the constraints set duration. Record the brief in the storyboard overview (`libi.add_storyboard_card({ overview })`) so a later session can read it back.

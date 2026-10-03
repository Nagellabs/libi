# UGC craft

The model-agnostic craft that makes AI UGC read as a real person. `SKILL.md` owns the default shape of the ad and the gates; the format formulas file in `prompts/` owns the prompt layers; `prompts/script-craft.md` owns tone and the pacing cue. This file holds what they share: how long a clip needs to be, the realism cue banks, consistency phrasing, and the one banned-word list.

## Clip length from the script

People speak at about 2.5 words a second (150 WPM) at an unhurried pace with pauses. Size the whole clip's spoken script, not each beat, to runtime:

| Spoken words (whole clip) | Clip duration |
| --- | --- |
| 1 to 8 | 4 to 5 s |
| 9 to 15 | 6 to 8 s |
| 16 to 25 | 9 to 12 s |
| 26 to 35 | 13 to 15 s |
| 36 or more | needs more than one clip |

Read every line aloud at a relaxed pace and time it. If you have to rush, there is too much: shorten the line, cut filler or lengthen the clip. Silent beats cost no words, so lean on them; every ad has at least one silent action beat (a sip, an inspection, a reaction). The longest single clip the model can make is the target, taken from its guide or live schema, not from a number remembered here.

## Natural motion

AI video defaults to a frozen subject staring at the lens. Include three or four of: eyes briefly breaking contact (a glance down or aside, then back); small head tilts and micro-expressions, a half-laugh; weight shifts, a gesture with the free hand, leaning in or out; slight handheld drift as if holding the phone.

## Skin realism

Include two or three reality cues (visible pores, fine lines, slight shine, stray hairs, uneven tone, faint under-eye shadow, light freckles if they suit the character); without them the output is airbrushed. Use texture cues only, never acne, pimples, breakouts, blemishes or rosacea: real is not dermatological.

## Character and product consistency

- A full-body shot is the hero reference: it gives the model face, hair, build, wardrobe and proportions, so every angle holds. A medium portrait forces it to invent the lower half.
- Cite the reference in words ("the exact same person from the reference image, same face, hair, eyes, build and clothing"), and freeze the core description: between generations vary only pose, setting and framing.
- Use the same product reference and repeat the product's name verbatim so it is not re-invented.

## Camera and exclusions

For the UGC formats, camera vocabulary that reads as a phone: smartphone front camera in selfie mode, native wide lens (about 26mm), subtle edge distortion, natural micro lens flare, mild luminance grain, slight rolling shutter. Where the model has a negative-prompt field, exclude (UGC formats only; a polished format drops the items that are its look): studio lighting, professional photography, stock photo, perfect skin, heavy makeup, centered framing, staged, LUT, colour graded, stabilisation, subtitles, captions, on-screen text. Where it has none, describe the real thing you want instead.

## Banned words

These are so over-represented in promotional captions that they anchor models toward the plastic AI look or generic ad speak. Keep them out of the spoken script of every format, and out of the visual prompt of the UGC formats (selfie, talking head, testimonial, demo-in-hand): there the polished words anchor the ad look instead of a person. When the brief contains one, paraphrase it into a visual specific before composing. The deliberately polished formats (studio lookbook, premium reveal, product hero) may name their stage literally ("clean studio backdrop", "studio-reveal shot", "cinematic" where the format is a brand film), because the polish is the point; the quality adjectives (stunning, flawless, masterpiece, 8k) stay out everywhere.

```
cinematic, professional, studio, studio lighting, stunning, beautiful, perfect,
flawless, masterpiece, award-winning, 8k, ultra-detailed, hyperrealistic, golden hour
```

| Instead of | Write |
| --- | --- |
| cinematic | dramatic or premium, or name the look (handheld documentary, shallow depth of field) |
| professional | real, candid, clean |
| studio, studio lighting | natural window light, bathroom vanity light, overhead kitchen light |
| stunning, beautiful | describe the subject (warm, glowing skin, clean lines) |
| 8k, ultra-detailed, hyperrealistic | photorealistic, true-to-life skin texture, natural phone quality |
| perfect, flawless | natural, lived-in, real; imperfection is the point in UGC |
| masterpiece, award-winning | drop it |
| golden hour | name the light: low warm side light, late-afternoon glow through blinds |

Nobody says "this is a cinematic, professional serum" out loud, and a model prompted with it films an ad, not a person.

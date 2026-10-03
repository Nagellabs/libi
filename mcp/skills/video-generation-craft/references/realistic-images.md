# Realistic images and keyframes

The image is the foundation of the clip: first/last-frame and image-to-video only animate the still you give them, so a weak or wrong keyframe poisons everything after it. This file is how to make one good image (a creator portrait, a character or product reference, a start or end keyframe). The calling skill decides when and how it becomes a clip; `ai-asset-generation` makes the call and saves the file.

## Choosing the model

**Use the strongest realism-and-anatomy model the provider has, and never let a recommendation tool pick it.** Priorities in order: correct anatomy (hands, fingers), prompt adherence, skin realism. The provider reference names the model.

- A provider's recommend and search tools optimize for capability and novelty, not realism; on a live provider they routinely put a weaker model first for a UGC portrait, and an agent that took the top hit shipped a mangled hand. Use those tools only to confirm the named model is available on this account and what it costs, never to choose another over it.
- Do not fall back to a weaker model because a stronger one "might need a key". The schema tool says whether it is available.
- Cost: keyframes are the best place to spend. If the user set a tight budget, state the trade in one line (strong model at about X each, or the cheaper one to save Y) and let them decide; do not downgrade silently.
- No reference for your provider: read the candidate models' schemas, pick on anatomy and adherence, and say which and why.

## Prompt craft for "a real phone photo, not AI"

- Quality adjectives and cliché light words ("beautiful", "perfect", "masterpiece", "8k", "hyperrealistic", "flawless", "studio lighting", "golden hour") anchor the plastic AI look. Paraphrase the brief into specifics: name the actual light ("low warm side light through a west window"), materials and real skin cues. The craft reference in the `ugc-product-video` skill keeps the full banned-word list and says which formats it applies to.
- Some image models take a negative-prompt field and some do not; the provider reference says which. Where there is none, phrase every exclusion positively ("realistic skin texture, visible pores", not "no plastic skin"); a negative pasted into the positive prompt makes the image worse.
- Include two or three skin-reality cues and one or two small imperfections (a stray hair, mid-blink, slight lens distortion). Avoid dermatological terms.

One filled-in template, a creator selfie; swap setting, time and outfit for the character:

```
Front-camera selfie of a [AGE]-year-old [ETHNICITY] [woman/man] with [HAIR] hair,
[BUILD] build, wearing [a casual outfit], no makeup, in [own kitchen / car driver's
seat / bedroom mirror], [morning light through the window / overhead kitchen light],
candid expression, mid-sentence, looking slightly off-camera, arm extended holding
the phone, slight lens distortion on the nose, visible skin texture and fine pores,
no retouching, faint under-eye shadow, one strand of hair out of place, blown
highlights on one cheek, amateur off-centre framing, vertical 9:16. A snapshot, not
a portrait.
```

## Before generating: is the prompt possible?

Read the prompt back and ask whether it describes something physically and anatomically possible to photograph and consistent with itself. Rewrite if not. Traps that have shipped:

- "Palms toward the camera" plus "showing fingernails": nails show on the back of the hand. Say "backs of hands toward the camera, fingers spread".
- A bare-nail start frame whose prompt also implies a manicure: be explicit, "completely bare natural nail, no polish".
- Two contradictory states of one object, impossible viewing angles, object counts that fight the framing.

## After generating: validate and keep the record

View the image against a checklist written for the specific thing requested (anatomy on the right side of the hand, plausible counts and proportions, the requested object present and correct, orientation as briefed, no fusing or stray text). "Looks nice" is not a pass.

Grade it: **A** passes as is; **B** has one mild AI tell (too-perfect teeth, a smooth jaw), note it and proceed; **C** (plastic skin, symmetry, studio backdrop, no imperfections) is regenerated. Save the check with `libi.analysis_save` action `summary` (and `libi.analysis_save` action `frames` for keyframes), keyed by `fileId`, so the validation is a record, not a remark. For one localized flaw, use the provider's masked-edit endpoint to repaint that region instead of re-rolling the image; each attempt is a paid generation. A bad keyframe is the cheapest thing to fix and the most expensive to ignore.

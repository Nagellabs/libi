# Physical-action beats

A beat where a character handles an object (filling, opening, pouring, applying, peeling, pressing, twisting, gripping and releasing, writing, cutting) is the one that falls apart in generation: the object wiggles, shrinks or vanishes mid-motion, a cap is on and off in the same second, a hand switches. Every frame looks plausible alone, so frame checks cannot catch it; the error is in the motion. The defense is a pinned end state, a decomposed prompt, a model that holds objects, and a way out when generation keeps failing.

Read `references/providers/<id>.md` before your first provider call: the first/last-frame endpoint, its input names and the engines to escalate through are there and nowhere else.

## 1. First/last frame first

Do not send a manipulation beat text-only to the cheapest tier. Pin the end state so the model must arrive there.

1. Make a clean **start frame** (the object a few millimetres from its destination, product large and sharp, anatomy right) and a clean **end frame** (the object in its final state) with `references/realistic-images.md`.
2. **View both** and confirm anatomy and product geometry before spending on video; flaws compound.
3. Generate with the model's first/last-frame mode and describe only the transition. First/last frame is either a dedicated endpoint or an end-image input on the ordinary image-to-video endpoint; confirm which, and the exact input names, with the schema tool.

## 2. Write the prompt as sub-steps

- **One verb per beat, three to five beats.** Fewer than three means you probably do not need decomposition; more than five (six for a compound open-fill-close-set-down) costs the model its hold on object identity. A clip is one dominant action; split the rest into separate clips.
- **Declare the starting state of every object before any verb**: "the cap is fully removed", "the bottle is empty and cap-free". This prevents the cap-on-and-off failure.
- **Anchor objects by relationship**, not just presence: "the glass rim near her lips", "she holds the selfie stick, which is the camera".
- **Verbs carry direction, axis and termination.** "Twists counterclockwise until it separates", "lifts the cap free and sets it on the counter", never "opens". Open-ended motion ("water flows into the bottle") runs on until the clip ends and degrades.
- **Say which hand and where**: "lifts it with her right hand from the counter". "Picks it up" switches grips between frames.
- **Directions relative to the frame** ("the hand enters from the right of the frame"), not to the body.
- **Keep the object's full name** across clips ("the matte-white nail box", never "the box"); an abbreviation reads as a new object.
- **Size the clip to the action.** An eight-second clip for a two-second action gets filled with invented motion.
- **Avoid**: two concurrent or contradictory actions ("twists the closed cap while pouring"), exact finger counts, and a prompt so long that the action state is outweighed by the lighting description.
- **Object-permanence anchor and tight shot**: "the named object stays visible in her hand and on the nail throughout; product shape and label preserved", a macro or close shot, product large in frame. Surgical negatives: `morphing, warping, shifting textures, flickering, floating objects, object disappearing, distorted label, extra fingers`.

Example, filling a bottle, one shot per line (on an engine that does not take timestamp brackets, write them as a short ordered list):

> Close-up from the front: her right hand unscrews the matte white cap from a transparent bottle, and the cap, fully removed, rests in her palm. The bottle is empty and cap-free.
> Medium shot: she sets the cap on the counter to her left and holds the open mouth of the bottle under the running faucet; water visibly enters from above while her left hand steadies the base.
> Static medium shot: the bottle fills to about three-quarters, she tilts it upright and turns off the faucet with her right hand. The cap stays on the counter. Motion settles to stillness.

## 3. Escalate only the failing beat

When the beat still fails validation after sections 1 and 2, move THAT beat up the engine ladder and leave the cheap beats on the cheap tier. The ladder is a shape, not a fixed ranking: a cheap first/last-frame tier, then an engine known for hands, close-ups and object permanence, then the strongest physics engine the provider currently serves. Which models fill it changes every few weeks, so find them at runtime with the provider's model search, schema and pricing tools (query for first-last-frame, fine object manipulation, hands) and treat the provider reference as a starting guess.

For a beat you already know is hard (a small object onto a body part, a contact lens, a patch, a lash), start at the strong model rather than burning two cheap attempts that will morph. Disclose the higher per-second cost before escalating and wait for the user's yes; each retry is paid.

## 4. Editorial fallback, when generation keeps failing

Stop spending. Restructure THAT beat so the model never renders the impossible instant:

- before and after as two clips with a hard cut between (object near the destination, cut, object already applied);
- a cutaway to a hands-only insert, cut on action;
- a real product photo composited at the reveal (an image overlay), so the product is never model-rendered at the critical frame.

This is a last resort for one beat, never the shape of the whole ad. Tell the user when sections 1 to 3 have not converged and offer it.

## 5. Making independent clips read as one video

Isolating a beat, or splitting it editorially, leaves independent clips with no memory of each other. Engineer the continuity, in order of impact:

1. **Frame-chain.** Extract the previous clip's last frame (`libi.analysis_extract` action `frames` with `timestamps` at the clip's duration minus 0.05 s) and use it as the next clip's start image or first-frame input. The seam disappears because the next clip begins on the pixels the last one ended on.
2. **Same character reference image** on every clip.
3. **Repeat descriptors verbatim**: lighting phrase, background, grade, wardrobe and the product's full name.
4. **Same engine, resolution, frame rate and aspect ratio**, so clips match and the export can stream-copy them.
5. **Hard cuts as cover.** A deliberate cut between beats reads as editing; the same mismatch mid-shot reads as AI. Cut exactly at the impossible moment.
6. **A product-grid reference** (the product from several angles, consistent light and scale) wherever a clip renders it.

Place the validated clips on the timeline as separate video overlays in order, or as a card's takes under a storyboard flow, rather than joining them into one file (`stitching-multi-clip`).

## Checking the motion

After generating, look at frames across the whole beat, and for any beat that manipulates the product run a video-understanding pass on your own provider through the `video-analysis` skill (flow B). That pass is paid on the user's provider credits: include it in the cost disclosure for the beat and get the yes before the beat's generation, not after. Ask yes/no questions drawn from your sub-steps: where the liquid comes from, whether the object is present in every frame, whether the grip holds, whether anything passes through anything. Accept on all yes; regenerate against the failing question otherwise.

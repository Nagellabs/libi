# Kling — prompt rules

Kling is a good pick for fine manipulation, close-ups and object permanence, and a sensible step up when a beat keeps morphing or losing the product mid-motion. It generates picture only; its audio has to come from elsewhere, so it cannot carry a voice. Endpoint ids and input names are in the provider reference; confirm with the schema tool.

## First/last frame is the primary path for manipulation

Pinning the END state forces Kling to arrive at the final state instead of improvising the object away. On the fal start/end endpoint the two images are separate inputs (names in the provider reference); some Kling tiers expose start and end too, so check the schema rather than assuming. Generate clean start and end keyframes and view both for anatomy and product geometry before spending on video: the clip is only as stable as its keyframes.

## Three actions at most per clip

Kling degrades when a clip stacks actions; keep to three, ideally one dominant action for a manipulation beat. Split compound actions into separate clips, placed as separate video overlays (`stitching-multi-clip`). Give a terminating verb and an end state ("presses the strip flat onto the nail and holds it there") and an object-permanence anchor ("the named object stays visible in her hand and on the nail throughout; product shape and label preserved"). Open-ended motion with no termination can hang generation near the end.

## B-roll

Good for product-on-a-surface, a hand reaching in, a slow reveal. Keep the product large in frame (small objects morph), lock a macro or close shot, reuse the same character and product reference image, and repeat the product's name verbatim across clips ("the matte-white nail box", never "the box") so it is not re-invented between independently generated clips.

Surgical negative prompt (do not over-stuff): `morphing, warping, shifting textures, flickering, floating objects, object disappearing, distorted label, extra fingers`.

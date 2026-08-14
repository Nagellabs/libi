/**
 * Builds the prompt for caption-focused analysis via fal-ai/video-understanding.
 *
 * The prompt is VERBATIM from a live investigation against the real
 * fal-ai/video-understanding model — do not paraphrase or reformat it.
 * It asks the model for per-caption numeric keyframes, anchor classification
 * (world vs screen-space), and flat-text-plane engine constraints so a
 * developer can rebuild the captions in a constrained 3D engine.
 */
export function buildCaptionAnalysisPrompt(): string {
  return `You are a technical director reverse-engineering the on-screen TEXT CAPTIONS in this video so a developer can rebuild them in a CONSTRAINED 3D engine. Analyze ONLY the captions.

THE TARGET ENGINE (only these primitives exist — give params for THIS, not generic three.js):
- Each caption = ONE flat text plane (a 2D-rasterized text texture on a plane) in a 3D scene with a perspective camera.
- You may set: plane world position (x,y,z), plane rotation (rotation.x / rotation.y / rotation.z, radians), font size, a glow (color + blur radius), per-frame opacity, and the camera position/animation.
- There is NO extruded 3D text, NO post-processing bloom, NO per-letter mesh. Approximate glow with blur; reveal letters by changing the plane's text string over time.

For EACH distinct caption output a terse, NUMERIC, directly-usable spec:
1. text: exact words.
2. appear_sec / exit_sec.
3. anchor: "world" or "screen". CRITICAL — does the caption stay locked to a fixed point in the 3D SCENE so it drifts / recedes / grows as the camera moves past it (world-anchored)? Or fixed on screen, only scaling/fading (screen-anchored)? State which. If world: give the motion path in words (e.g. "near-left foreground -> recedes to vanishing-point center-right, shrinking").
4. keyframes: EXACTLY 3 rows (appear, peak, exit). Each row: time_sec | center cx,cy (normalized 0..1, 0,0=top-left) | text height as FRACTION of frame height (0..1). Be accurate — these numbers must keep the text fully inside the frame and in the right place.
5. reveal: all-at-once OR progressive. If progressive, give the exact schedule: which characters/words are visible at which time_sec.
6. orientation: billboard (faces camera, rotation ~0), ground-tilted (lies on road, rotation.x ~ -1.2 rad), or roadside-wall (standing, receding to vanishing point, rotation.y ~ +0.8 rad). Give approx degrees + axis.
7. color (hex) + glow blur (small/medium/large) + font weight.

Finally: one short paragraph on the SHARED motion language — do ALL captions live in the 3D world and move with the camera, or are they screen-space? This decides the whole rebuild.

Be terse and numeric. NO generic advice. One block per caption.`;
}

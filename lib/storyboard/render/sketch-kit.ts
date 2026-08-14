/**
 * Shared constants for storyboard "rough" canvas sketch units. Kept in one place
 * so the renderer injection (`render/canvas.ts`) and the `using-storyboard` skill
 * documentation can't drift.
 */

/** Fixed Rough.js seed → byte-stable re-renders (parity with the svg/satori
 *  units, which are deterministic). Injected as the RoughCanvas default seed. */
export const ROUGH_SEED = 7;

/** Near-black ink for sketch linework. */
export const INK = "#1a1a1a";

/** Light→dark grayscale value ramp for depth layering: distant elements use the
 *  lighter end, foreground the darker end. */
export const GRAYS = [
  "#e3e0d8",
  "#cdc9c0",
  "#b6b1a8",
  "#9b968c",
  "#736e65",
  "#403c35",
] as const;

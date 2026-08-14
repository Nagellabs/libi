/**
 * Whether the on-canvas transform UI for the selected overlay should be shown.
 *
 * This gates EVERY draggable transform surface drawn over the canvas from the
 * selected overlay's geometry — the 2D text glyph handles, the non-text
 * transform box, both 3D orbit gizmos, and the "facing away" readability pill.
 *
 * Two reasons it's hidden WHILE PLAYING:
 *   1. Stutter — that subtree re-renders every frame and its per-frame
 *      allocation triggers a recurring major GC → playback stutter (measured:
 *      selecting a 3D overlay = 0→6 GC hitches/10s). Keyframed overlays would
 *      also make the gizmo chase the box one frame behind.
 *   2. Pro-editor behavior — handles vanish during playback and reappear on
 *      pause; you can't drag a transform handle while the clip is playing.
 *
 * Pure boolean so it can be unit-tested without mounting the (very heavy)
 * PreviewPlayer subtree. Keep the `!playing` term here — the source-scan guard
 * (`__tests__/unit/preview/transform-ui-playback-gate.test.tsx`) asserts every
 * transform-UI mount routes through this gate.
 *
 * @param playing - transport is currently playing
 * @param selectedOverlayActiveAtPlayhead - a selected overlay whose
 *   `[startTime, startTime + duration)` window covers the current playhead
 */
export function showTransformUi(
  playing: boolean,
  selectedOverlayActiveAtPlayhead: boolean,
): boolean {
  return !playing && selectedOverlayActiveAtPlayhead;
}

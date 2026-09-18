/** Canvas2D state-stack hygiene shared by the compositor and the overlay renderer. */

/**
 * Run `draw` so the canvas state stack is exactly as deep afterwards as it was
 * before, whatever `draw` does — throws midway, returns with a save() still
 * open, or restore()s more than it saved.
 *
 * Canvas2D has no depth query, so for the duration of the call `save`/`restore`
 * are shadowed on the context instance with counting wrappers: every save the
 * draw (or a code body it calls) pushes is popped in `finally`, and a restore
 * with nothing of its own to pop is ignored instead of eating the caller's
 * state. Without this, `drawOverlay`'s save + clip-to-rect leaked whenever a
 * code body threw, and every later draw — including the next frame's
 * clearRect and base video — was clipped to that overlay's rect (QA
 * 2026-09-18 N1: the export's video froze outside the broken overlay).
 */
export function drawWithBalancedState(ctx: CanvasRenderingContext2D, draw: () => void): void {
  const save = ctx.save;
  const restore = ctx.restore;
  let depth = 0;
  ctx.save = function balancedSave(this: CanvasRenderingContext2D) {
    depth++;
    save.call(ctx);
  };
  ctx.restore = function balancedRestore(this: CanvasRenderingContext2D) {
    if (depth === 0) return;
    depth--;
    restore.call(ctx);
  };
  try {
    draw();
  } finally {
    ctx.save = save;
    ctx.restore = restore;
    while (depth > 0) {
      depth--;
      restore.call(ctx);
    }
  }
}

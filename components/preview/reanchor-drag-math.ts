/** Map a pointer client point to composition-pixel space using the canvas
 *  DISPLAY rect (mirrors PreviewPlayer.handleCanvasClick scaling). */
export function screenToCompositionPoint(
  pt: { clientX: number; clientY: number },
  bounds: DOMRect,
  compWidth: number,
  compHeight: number,
): { x: number; y: number } {
  const scaleX = compWidth / bounds.width;
  const scaleY = compHeight / bounds.height;
  return {
    x: (pt.clientX - bounds.left) * scaleX,
    y: (pt.clientY - bounds.top) * scaleY,
  };
}

import type { AspectRatioOption } from "@/lib/composition/aspect-ratio";
import { describeRatio, orientationOf } from "@/lib/composition/aspect-ratio";

/**
 * The prompt sent (or copied) when the user changes a piece's aspect ratio
 * from the picker and the piece already has content.
 *
 * The agent performs the change rather than the UI, because a resize alone
 * would strand every overlay outside the new frame — repositioning is the
 * actual work, and only the agent can do it.
 *
 * Named tools and literal arguments are deliberate: this exact text is what a
 * bring-your-own-CLI user copies into their own agent, where none of libi's
 * UI context exists.
 */
export function buildAspectChangePrompt(args: {
  pieceId: string;
  pieceName: string;
  currentWidth: number;
  currentHeight: number;
  target: AspectRatioOption;
  targetWidth: number;
  targetHeight: number;
  overlayCount: number;
}): string {
  const {
    pieceId, pieceName,
    currentWidth, currentHeight,
    target, targetWidth, targetHeight,
    overlayCount,
  } = args;

  const currentLabel = describeRatio(currentWidth, currentHeight);
  const currentOrientation = orientationOf(currentWidth, currentHeight);
  const plural = overlayCount === 1 ? "1 overlay" : `${overlayCount} overlays`;

  return [
    `Change this piece's aspect ratio to ${target.id} (${target.orientation}, ${targetWidth}x${targetHeight}).`,
    ``,
    `Call libi.update_composition_dimensions with pieceId "${pieceId}", width ${targetWidth}, height ${targetHeight}.`,
    `Then reposition and rescale the existing ${plural} to fit the new frame — nothing cut off`,
    `or left outside the canvas. Use libi.retrieve_assets_dimensions first to see current rects.`,
    ``,
    `Piece:   ${pieceName} (${pieceId})`,
    `Current: ${currentWidth}x${currentHeight} (${currentLabel}, ${currentOrientation})`,
    `Target:  ${targetWidth}x${targetHeight} (${target.id}, ${target.orientation})`,
  ].join("\n");
}

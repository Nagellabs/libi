import { describeRatio } from "@/lib/composition/aspect-ratio";

/** A rect must cover at least this share of the frame to count as full-frame. */
const COVERAGE_GATE = 0.8;
/** Relative aspect difference above which a full-frame clip is a mismatch. */
const ASPECT_GATE = 0.1;

/**
 * Warn when an overlay looks like a full-frame element whose source media
 * does not match the frame it is being placed in.
 *
 * This exists because `fal-ai` is a separate bundled MCP the agent calls
 * itself — libi cannot inject an aspect_ratio into those params the way the
 * storyboard path does. Detecting the mismatch after the fact is the only
 * lever left.
 *
 * BOTH gates must trip. The coverage gate is what makes the warning usable:
 * without it, every deliberate picture-in-picture or inset would warn, and a
 * warning that fires on correct work is a warning nobody reads.
 *
 * Returns a message, never a rejection — a deliberate mismatch is legitimate;
 * the agent just has to have decided on it rather than stumbled into it.
 */
export function aspectMismatchWarning(args: {
  compWidth: number;
  compHeight: number;
  mediaWidth: number | null;
  mediaHeight: number | null;
  rect: { x: number; y: number; width: number; height: number };
}): string | null {
  const { compWidth, compHeight, mediaWidth, mediaHeight, rect } = args;

  if (!(compWidth > 0) || !(compHeight > 0)) return null;
  // Unknown media dimensions (ffprobe unavailable, or a still not yet probed)
  // are not evidence of a mismatch.
  if (!mediaWidth || !mediaHeight) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;

  const coverage = (rect.width * rect.height) / (compWidth * compHeight);
  if (coverage < COVERAGE_GATE) return null;

  const compAspect = compWidth / compHeight;
  const mediaAspect = mediaWidth / mediaHeight;
  if (Math.abs(mediaAspect - compAspect) / compAspect <= ASPECT_GATE) return null;

  return (
    `This ${mediaWidth}x${mediaHeight} (${describeRatio(mediaWidth, mediaHeight)}) source fills a ` +
    `${compWidth}x${compHeight} (${describeRatio(compWidth, compHeight)}) frame, so it will be ` +
    `cropped or letterboxed. If that was not intended, generate at the piece's aspect ratio ` +
    `(pass aspect_ratio to the generation model) or change the canvas with ` +
    `libi.update_composition_dimensions.`
  );
}

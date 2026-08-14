import type { AnalysisBundle, AnalysisKeyframe } from "./types";

/**
 * Lean projection of an {@link AnalysisBundle} for the default `analysis_get`
 * response. Dogfood finding F5: a fully-described analysis (e.g. 26 keyframes)
 * serializes the entire structured `FrameDescription` per frame, which blows
 * past the agent's per-tool token limit (~134 KB observed) — the result gets
 * dumped to a file and the agent has to scrape it back.
 *
 * The summary keeps everything the agent needs to reason about analysis STATE
 * (which frames exist, their timestamps, whether they're described / skipped)
 * but replaces each frame's heavy `description`/`custom` blobs with a short
 * preview + boolean flags. Full per-frame data is still available via
 * `libi.analysis_search_frames` or `analysis_get` with `frameDetail: "full"`.
 */
const DESCRIPTION_PREVIEW_CHARS = 160;

export interface LeanKeyframe
  extends Omit<AnalysisKeyframe, "description" | "custom"> {
  /** True when the frame has a saved FrameDescription. */
  hasDescription: boolean;
  /** True when the frame carries a custom freeform bag. */
  hasCustom: boolean;
  /** First ~160 chars of the raw description JSON, for a cheap at-a-glance hint. */
  descriptionPreview: string | null;
}

export interface LeanAnalysisBundle
  extends Omit<AnalysisBundle, "keyframes"> {
  keyframes: LeanKeyframe[];
  frameDetail: "summary";
  /** Tells the agent how to get the full per-frame data when it needs it. */
  note: string;
}

function preview(description: string | null): string | null {
  if (!description) return null;
  const trimmed = description.trim();
  return trimmed.length > DESCRIPTION_PREVIEW_CHARS
    ? trimmed.slice(0, DESCRIPTION_PREVIEW_CHARS - 1) + "…"
    : trimmed;
}

export function summarizeAnalysisBundle(
  bundle: AnalysisBundle,
): LeanAnalysisBundle {
  return {
    ...bundle,
    keyframes: bundle.keyframes.map((kf) => {
      // Drop the heavy per-frame blobs; keep the rest of the row verbatim.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { description, custom, ...rest } = kf;
      return {
        ...rest,
        hasDescription: description != null,
        hasCustom: custom != null,
        descriptionPreview: preview(description),
      };
    }),
    frameDetail: "summary",
    note:
      "Keyframe descriptions are summarized to stay within the tool token budget. " +
      'Use libi.analysis_search_frames for targeted frame details, or call ' +
      'libi.analysis_get with frameDetail:"full" for the complete per-frame data.',
  };
}

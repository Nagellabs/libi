/**
 * The colour declaration the ffmpeg-overlay export puts on an UNTAGGED HD
 * video input — the base, and every video overlay — before it is composited.
 *
 * ffmpeg converts every overlay into the base frame's YUV using the FRAME's
 * matrix, and to ffmpeg an untagged frame is BT.601. The output inherits the
 * frame's tags, so an untagged base produced an untagged export. Browsers
 * (the editor preview decodes with Chromium) and QuickTime read untagged HD
 * as BT.709, so a pure green overlay exported from an untagged 1080p clip
 * showed as 0,216,0 where the preview drew 0,255,0. The base itself looked
 * the same in the export as in the preview — only what was composited on it
 * was off.
 *
 * Declaring the untagged HD base BT.709 with `setparams` fixes that without
 * touching a single base pixel: setparams rewrites frame metadata only, so the
 * base's YUV passes through as before, the overlays convert with 709, and the
 * encoder writes the 709 tags — every player now reads the file the way the
 * preview showed it.
 *
 * A VIDEO overlay needs the same declaration. Once the base is 709, ffmpeg
 * converts an overlay video from its own matrix into the base's, and an
 * untagged HD overlay would be converted FROM 601 — shifting it away from
 * the 709 reading the preview shows it with. (Before this change the two
 * untagged streams were never converted, which happened to be right.)
 * Measurements: docs-local/superpowers/plans/backlog-task-1-report.md.
 *
 * Deliberately left alone:
 *  - A TAGGED stream (its matrix is known): ffmpeg and every player already
 *    agree on it, and a tagged base's tags carry through to the output.
 *  - An untagged SD stream exported at SD size: players read it as BT.601 —
 *    the matrix ffmpeg assumes too — so it is already right. Exported at HD
 *    size it is NOT: see `untaggedSdToHdConversion` below.
 *  - The in-between sizes (720×480, 1024×576, 854×480…): macOS
 *    (Chromium's hardware decode, QuickTime) reads them untagged as 709,
 *    mpv/libplacebo as 601. Where the conventions disagree, the export keeps
 *    today's behaviour rather than guess.
 *  - Non-YUV streams (RGB codecs, images): there is no YUV matrix to declare.
 */

export interface StreamColorProbe {
  width?: number;
  height?: number;
  /** ffprobe `pix_fmt`. */
  pixFmt?: string;
  /** ffprobe `color_space` (the YUV matrix); absent when untagged. */
  colorSpace?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
}

/**
 * Untagged video at or above these sizes is read as BT.709 by every player
 * convention checked (Chromium/CoreVideo on macOS: width ≥ 720 or height > 576;
 * mpv/libplacebo: width ≥ 1280 or height > 576). This is inside both. The
 * sizes are the CODED ones ffprobe reports — what a decoder decides by.
 */
function isHd(width: number, height: number): boolean {
  return width >= 1280 || height >= 720;
}

/**
 * The `setparams=…` stage to put first on a video input's chain, or null when
 * the stream needs no declaration. Only fields the stream leaves unset are
 * written — a tagged transfer is never overridden, and a stream whose
 * primaries are tagged as anything but bt709 gets no declaration at all. Range is never
 * touched: untagged means limited range to ffmpeg and players alike, and a
 * full-range `yuvj*` stream must keep reading as full.
 */
export function untaggedHdColorParams(probe: StreamColorProbe): string | null {
  const { width, height, pixFmt } = probe;
  if (!width || !height || !pixFmt || !pixFmt.startsWith("yuv")) return null;
  if (probe.colorSpace) return null;
  // Primaries tagged as something else (bt2020, bt470bg, …) contradict a 709
  // guess for the matrix; leave such a stream exactly as today.
  if (probe.colorPrimaries && probe.colorPrimaries !== "bt709") return null;
  if (!isHd(width, height)) return null;
  const fields = ["colorspace=bt709"];
  if (!probe.colorPrimaries) fields.push("color_primaries=bt709");
  if (!probe.colorTransfer) fields.push("color_trc=bt709");
  return `setparams=${fields.join(":")}`;
}

/**
 * Unambiguously SD: every convention above reads untagged video this size as
 * BT.601 (Chromium/CoreVideo switch to 709 at width ≥ 720 or height > 576).
 */
function isClearSd(width: number, height: number): boolean {
  return width < 720 && height <= 576;
}

/**
 * The 601 → 709 conversion an UNTAGGED SD base needs when the export is NOT
 * SD-sized, or null.
 *
 * Text, code and 3D raise the output to at least the graphics tier (1080p
 * short edge), so a 640×480 clip with one caption exports at 1440×1080. The
 * base used to stay untagged BT.601 while the file became HD, and every player
 * reads untagged HD as BT.709: the base played shifted by up to 30 and a pure
 * green overlay as 0,214,0 (QA 2026-09-19 Q1).
 *
 * The base's fit scale converts the matrix (`in_color_matrix=bt601`, what the
 * preview reads the SD source as, to `out_color_matrix=bt709`) and the result
 * is declared 709, so overlays convert with 709 and the encoder writes 709
 * tags. Measured through Chromium (the preview's decode) on a 640×480 source:
 * base within 1 of the source, green 1,254,0, at 1440×1080 and 2880×2160.
 *
 * Tagging the output 601 instead (`setparams=…smpte170m` on the base) reads
 * the same in Chromium, but a player that ignores tags guesses by SIZE, and
 * at HD size it guesses 709 — the tagged-709 output is right for both kinds.
 * (`bt470bg` primaries are worse still: Chromium gamut-maps them, Δ18.)
 *
 * The scale keeps the range, so a full-range yuvj source stays full. A tagged
 * transfer is kept; primaries tagged as anything but smpte170m / bt709 leave
 * the stream alone, like `untaggedHdColorParams`.
 */
export function untaggedSdToHdConversion(
  probe: StreamColorProbe,
  output: { width: number; height: number },
): { scaleArgs: string; params: string } | null {
  const { width, height, pixFmt } = probe;
  if (!width || !height || !pixFmt || !pixFmt.startsWith("yuv")) return null;
  if (probe.colorSpace) return null;
  if (probe.colorPrimaries && probe.colorPrimaries !== "smpte170m" && probe.colorPrimaries !== "bt709") return null;
  if (!isClearSd(width, height)) return null;
  if (isClearSd(output.width, output.height)) return null;
  const fields = ["colorspace=bt709", "color_primaries=bt709"];
  if (!probe.colorTransfer) fields.push("color_trc=bt709");
  return {
    scaleArgs: ":in_color_matrix=bt601:out_color_matrix=bt709",
    params: `setparams=${fields.join(":")}`,
  };
}

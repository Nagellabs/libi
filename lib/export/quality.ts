import type { ExportQuality, ExportSettings } from "@/lib/engine/types";

/**
 * Target SHORT edge for each named preset. Short edge, not width: a preset
 * names a quality tier, and the frame's orientation belongs to the piece.
 * Reading these as widths is what made a portrait piece export landscape.
 *
 * A 16:9 piece is unaffected — 1080 on the short edge is still 1920x1080.
 */
const PRESET_SHORT_EDGE: Record<Exclude<ExportQuality, "source" | "custom">, number> = {
  "1080p": 1080,
  "1440p": 1440,
  "4k": 2160,
};

/** Lookup table: bits/sec per (codec, max-dimension). Numbers reflect a
 *  "good visual quality at 30fps" target for H.264. WebM/VP9 needs ~20%
 *  less for similar perceived quality but we don't differentiate yet. */
function bitrateForPixels(pixelCount: number): number {
  // Bitrate ladder anchored at 1080p ≈ 8 Mbps. Scales linearly with pixel
  // count above 1080p so 4K lands at ~32 Mbps. Below 1080p we keep 4 Mbps
  // as a floor — small videos still get clean encodes.
  const anchorPixels = 1920 * 1080;
  const anchorBitrate = 8_000_000;
  if (pixelCount <= anchorPixels) {
    return Math.max(4_000_000, Math.round((pixelCount / anchorPixels) * anchorBitrate));
  }
  return Math.round((pixelCount / anchorPixels) * anchorBitrate);
}

/** Target dimensions for a named preset against a given source resolution.
 *  Pure, and the SAME logic the server (`resolveExportSettings`) and the
 *  export dialog UI both resolve against — there must be only one table.
 *  Preserves the composition's own aspect and orientation; the preset only
 *  sets the quality tier. Guards the ratio so a degenerate source (0 height
 *  from a corrupt manifest) yields a square frame rather than NaN
 *  dimensions, which fail deep inside ffmpeg with an opaque message. */
export function presetDimensions(
  quality: Exclude<ExportQuality, "source" | "custom">,
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  const shortEdge = PRESET_SHORT_EDGE[quality];
  const ar = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 1;
  let width: number;
  let height: number;
  if (ar >= 1) {
    height = shortEdge;
    width = Math.round(shortEdge * ar);
  } else {
    width = shortEdge;
    height = Math.round(shortEdge / ar);
  }
  // Round to even pixels — H.264 yuv420p needs even dimensions.
  return { width: width & ~1, height: height & ~1 };
}

/** Resolve a partial ExportSettings + a source resolution into a fully-typed
 *  settings object with concrete width/height/bitrate. Pure. */
export function resolveExportSettings(
  partial: Pick<ExportSettings, "format" | "codec" | "fps" | "quality" | "audioBitrate"> & {
    sourceWidth: number;
    sourceHeight: number;
    customWidth?: number;
    customHeight?: number;
  },
): ExportSettings {
  const quality: ExportQuality = partial.quality ?? "source";
  let width = partial.sourceWidth;
  let height = partial.sourceHeight;

  if (quality === "custom") {
    if (!partial.customWidth || !partial.customHeight) {
      throw new Error("custom quality requires customWidth and customHeight");
    }
    width = partial.customWidth;
    height = partial.customHeight;
  } else if (quality !== "source") {
    const dims = presetDimensions(quality, partial.sourceWidth, partial.sourceHeight);
    width = dims.width;
    height = dims.height;
  }

  // Round to even pixels — H.264 yuv420p needs even dimensions.
  width = width & ~1;
  height = height & ~1;

  const bitrate = bitrateForPixels(width * height);
  const audioBitrate = partial.audioBitrate ?? 256_000;

  return {
    format: partial.format,
    codec: partial.codec,
    bitrate,
    audioBitrate,
    width,
    height,
    fps: partial.fps,
    quality,
  };
}

/** True when the target resolution is strictly larger than the source. UI
 *  uses this to surface the upscaling warning. Takes just the target
 *  dimensions (not a full ExportSettings) so callers that only have
 *  `presetDimensions`'s output — like the export dialog — don't need to
 *  fabricate bitrate/codec/etc just to ask this question. */
export function isUpscaling(
  target: Pick<ExportSettings, "width" | "height">,
  sourceWidth: number,
  sourceHeight: number,
): boolean {
  return target.width > sourceWidth || target.height > sourceHeight;
}

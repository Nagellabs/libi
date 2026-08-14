import type { ExportQuality, ExportSettings } from "@/lib/engine/types";

/** Target resolution for each named quality preset. "source" returns null. */
export interface QualityResolution {
  width: number;
  height: number;
}

const PRESET_RES: Record<Exclude<ExportQuality, "source" | "custom">, QualityResolution> = {
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "4k": { width: 3840, height: 2160 },
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
    const preset = PRESET_RES[quality];
    width = preset.width;
    height = preset.height;
  }

  // Round to even pixels — H.264 yuv420p needs even dimensions.
  width = width & ~1;
  height = height & ~1;

  const bitrate = bitrateForPixels(width * height);
  const audioBitrate = partial.audioBitrate ?? 192_000;

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
 *  uses this to surface the upscaling warning. */
export function isUpscaling(settings: ExportSettings, sourceWidth: number, sourceHeight: number): boolean {
  return settings.width > sourceWidth || settings.height > sourceHeight;
}

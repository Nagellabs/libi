import type { ExportQuality, ExportSettings, GraphicsQuality } from "@/lib/engine/types";

/** Text, code and 3D render procedurally at the output size, so 4K is the
 *  default: it is what keeps them crisp. */
export const DEFAULT_GRAPHICS_QUALITY: GraphicsQuality = "4k";

/** Shown under every graphics choice below the default. */
export const GRAPHICS_SHARPNESS_WARNING = "Text, code and 3D may look less sharp at this resolution. 4K keeps them crisp.";

export function graphicsLosesSharpness(q: GraphicsQuality): boolean {
  return q !== DEFAULT_GRAPHICS_QUALITY;
}

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

/** Overlay kinds that render text/code/3D graphics procedurally — the tier
 *  `graphicsQuality` governs. Plain image/video overlays are decoded media,
 *  not rendered, so they're governed by `quality` (media) only. */
const GRAPHICS_OVERLAY_KINDS = new Set(["text", "code", "three"]);
/** `tracked` overlay content kinds that are themselves graphics (a tracked
 *  emoji/text/code draw), as opposed to tracked image/video/effect content
 *  which decode or filter existing pixels. */
const GRAPHICS_TRACKED_CONTENT_KINDS = new Set(["text", "code", "emoji"]);

/** True when the composition has any overlay whose content is rendered as
 *  text/code/3D graphics — the signal that gates the `graphicsQuality` tier
 *  in `resolveOutputDimensions`. Pure; accepts an empty/undefined list.
 *  Structurally typed so both the live `Overlay` and the persisted manifest
 *  shape pass without a cast. Canvas `scenes` are not counted (they are
 *  almost always empty), and a hidden graphics overlay still counts. */
export function hasGraphicsOverlays(
  overlays: ReadonlyArray<{ kind: string; content?: unknown }> | undefined,
): boolean {
  if (!overlays) return false;
  return overlays.some((overlay) => {
    if (GRAPHICS_OVERLAY_KINDS.has(overlay.kind)) return true;
    if (overlay.kind === "tracked") {
      // A text overlay's `content` is a string; only a tracked overlay's is
      // a `{ kind }` object, so narrow before reading it.
      const content = overlay.content as { kind?: unknown } | undefined;
      return typeof content?.kind === "string" && GRAPHICS_TRACKED_CONTENT_KINDS.has(content.kind);
    }
    return false;
  });
}

/** Resolve the final output frame from a media resolution (videos & images)
 *  and a graphics resolution (text/code/3D), per the export-quality-split
 *  design: an export is one raster frame, so the two tiers must collapse to
 *  one size. `custom` wins outright — it's an explicit, API-only override
 *  that ignores both tiers. Otherwise the media tier's frame is raised to
 *  the graphics tier's frame (against the SAME composition aspect) when the
 *  piece has graphics overlays and that tier has more pixels — videos are
 *  never downscaled below the chosen media tier, and graphics render
 *  procedurally at the output size, so they come out sharp either way. */
export function resolveOutputDimensions(args: {
  quality: ExportQuality;
  graphicsQuality: GraphicsQuality;
  hasGraphics: boolean;
  sourceWidth: number;
  sourceHeight: number;
  customWidth?: number;
  customHeight?: number;
}): { width: number; height: number; drivenBy: "media" | "graphics" } {
  const { quality, graphicsQuality, hasGraphics, sourceWidth, sourceHeight, customWidth, customHeight } = args;

  if (quality === "custom") {
    if (!customWidth || !customHeight) {
      throw new Error("custom quality requires customWidth and customHeight");
    }
    return { width: customWidth & ~1, height: customHeight & ~1, drivenBy: "media" };
  }

  const mediaDims =
    quality === "source" ? { width: sourceWidth, height: sourceHeight } : presetDimensions(quality, sourceWidth, sourceHeight);

  if (!hasGraphics) {
    return { width: mediaDims.width & ~1, height: mediaDims.height & ~1, drivenBy: "media" };
  }

  const graphicsDims = presetDimensions(graphicsQuality, sourceWidth, sourceHeight);
  const mediaPixels = mediaDims.width * mediaDims.height;
  const graphicsPixels = graphicsDims.width * graphicsDims.height;
  const graphicsWins = graphicsPixels > mediaPixels;
  const winner = graphicsWins ? graphicsDims : mediaDims;

  return { width: winner.width & ~1, height: winner.height & ~1, drivenBy: graphicsWins ? "graphics" : "media" };
}

/** Default AAC bitrate for MP4. */
const AAC_DEFAULT_BITRATE = 320_000;

/** libopus accepts at most 256 kbps PER CHANNEL, so anything higher fails a
 *  mono source with "Could not open encoder" and the whole WebM export dies.
 *  The channel count isn't known here, so 256k is both the Opus default and
 *  its ceiling: it is valid at any channel count and already transparent. */
export const OPUS_MAX_BITRATE = 256_000;

/** The one place the audio bitrate is decided — `resolveExportSettings` and
 *  every backend's fallback (for settings that bypassed it) call this, so a
 *  default can't drift per codec again. */
export function resolveAudioBitrate(format: ExportSettings["format"], requested?: number): number {
  if (format === "webm") return Math.min(requested ?? OPUS_MAX_BITRATE, OPUS_MAX_BITRATE);
  return requested ?? AAC_DEFAULT_BITRATE;
}

/** Resolve a partial ExportSettings + a source resolution into a fully-typed
 *  settings object with concrete width/height/bitrate. Pure. */
export function resolveExportSettings(
  partial: Pick<ExportSettings, "format" | "codec" | "fps" | "quality" | "audioBitrate" | "graphicsQuality"> & {
    sourceWidth: number;
    sourceHeight: number;
    customWidth?: number;
    customHeight?: number;
    /** True when the composition has any text/code/3D overlay. Absent ⇒
     *  false — existing callers that don't pass this keep resolving purely
     *  off `quality`, as before graphics resolution existed. */
    hasGraphics?: boolean;
  },
): ExportSettings {
  const quality: ExportQuality = partial.quality ?? "source";
  // Absent ⇒ "4k" (sharpest) — matches the stored-settings + MCP defaults so
  // an omitted graphicsQuality never silently downgrades a graphics-bearing
  // export.
  const graphicsQuality: GraphicsQuality = partial.graphicsQuality ?? DEFAULT_GRAPHICS_QUALITY;
  const hasGraphics = partial.hasGraphics ?? false;

  const { width, height } = resolveOutputDimensions({
    quality,
    graphicsQuality,
    hasGraphics,
    sourceWidth: partial.sourceWidth,
    sourceHeight: partial.sourceHeight,
    customWidth: partial.customWidth,
    customHeight: partial.customHeight,
  });

  const bitrate = bitrateForPixels(width * height);
  const audioBitrate = resolveAudioBitrate(partial.format, partial.audioBitrate);

  return {
    format: partial.format,
    codec: partial.codec,
    bitrate,
    audioBitrate,
    width,
    height,
    fps: partial.fps,
    quality,
    graphicsQuality,
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

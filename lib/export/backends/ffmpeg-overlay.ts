import fs from "fs";
import { dirname } from "path";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { vpxAlphaDecodeArgs } from "@/lib/ffmpeg/alpha";
import { exportLogger as logger } from "@/lib/logger";
import { detectAvailableEncoders, pickEncoder } from "../hw-accel";
import { drawtextSpecFor, assetOverlaySegments } from "../overlay-filter";
import { buildAudioMixGraph } from "../audio-mix";
import { duckSidechainIds } from "@/lib/audio/duck-params";
import { renderDuckEnvelopes, type DuckEnvelopeInput, type PlacedSidechain } from "../duck-envelopes";
import { baseTimeRange, resolveExportBase } from "../export-base";
import type { ExportBackend, ExportContext } from "../backend";
import type {
  ExportResult,
  Overlay,
  ImageOverlay,
  VideoOverlay,
  AudioClip,
} from "@/lib/engine/types";

/**
 * FfmpegOverlayBackend — composites typed overlays (text/image/video) on
 * top of a single base video using ffmpeg's filter_complex. The base comes
 * from `resolveExportBase`: a legacy video SCENE, or a full-frame bottom-z
 * video OVERLAY (which is then excluded from the composited set). Plan 4
 * scope: code overlays are NOT handled here (the classifier gates them
 * out to the canvas-source path); this backend only runs when
 * comp.overlays contains exclusively text/image/video kinds.
 *
 * Reads ORIGINAL files via storage.localPath — never the proxy (Plan 3
 * invariant for server backends).
 */
export class FfmpegOverlayBackend implements ExportBackend {
  name = "ffmpeg-overlay" as const;

  async run(ctx: ExportContext): Promise<ExportResult> {
    // The base is a legacy video SCENE or a base-shaped video OVERLAY — the
    // resolver is the single authority the classifier also reads.
    const base = resolveExportBase(ctx.composition);
    if (!base) {
      throw new Error("FfmpegOverlayBackend: composition has no resolvable base video");
    }
    // CRITICAL: when the base came from an overlay, that overlay IS ffmpeg
    // input [0:v]. It must be excluded from every list that produces an extra
    // `-i` input or a filter segment, or it would be composited on top of
    // itself — drawing the full-frame background over everything above it
    // (which presents as "my cutouts disappeared").
    const overlays = (ctx.composition.overlays ?? []).filter((o) => o.id !== base.overlayId);
    const audioClips = ctx.composition.audioClips ?? [];

    if (!ctx.outputPath) {
      throw new Error("FfmpegOverlayBackend requires ctx.outputPath");
    }

    const db = getDb();
    const [baseFile] = db.select().from(files).where(eq(files.id, base.fileId)).limit(1).all();
    if (!baseFile) throw new Error(`Base file not found: ${base.fileId}`);
    const storage = await getStorage();
    if (!(storage instanceof LocalFileStorage)) {
      throw new Error("FfmpegOverlayBackend requires local storage");
    }
    const basePath = storage.localPath(baseFile.pieceId, baseFile.filename);

    // Collect non-text overlays that need an extra -i input, resolve their file paths.
    const assetOverlays: (ImageOverlay | VideoOverlay)[] = overlays.filter(
      (o): o is ImageOverlay | VideoOverlay => o.kind === "image" || o.kind === "video",
    );
    const assetFileIds = assetOverlays.map((o) => o.fileId);
    const clipFileIds = audioClips.map((c) => c.fileId);
    const extraFileIds = Array.from(new Set([...assetFileIds, ...clipFileIds]));
    const extraFiles =
      extraFileIds.length > 0
        ? db.select().from(files).where(inArray(files.id, extraFileIds)).all()
        : [];
    const fileById = new Map(extraFiles.map((f) => [f.id, f]));

    // Map each overlay to its input index (scene = [0:v]; assets start at [1:v]).
    // Each input gets its own INPUT-option args (placed before its `-i`):
    // alpha-bearing VPx WebM (matte_gen cutouts, fal transparent imports) must
    // decode via libvpx — ffmpeg's NATIVE vp9 decoder silently skips the WebM
    // alpha side-band, which would composite the cutout fully opaque (the
    // original scene, background and all) over the base.
    const alphaDecodeArgsFor = async (
      f: { hasAlpha: boolean | null; pieceId: string | null; filename: string },
    ): Promise<string[]> => {
      if (!f.hasAlpha) return [];
      const probed = await probeMedia(storage.localPath(f.pieceId, f.filename));
      return vpxAlphaDecodeArgs({ hasAlpha: true, videoCodec: probed.videoCodec });
    };
    const inputPaths: string[] = [basePath];
    const inputOptionArgs: string[][] = [await alphaDecodeArgsFor(baseFile)];
    const assetInputIndex = new Map<string, number>(); // overlay.id -> ffmpeg input index
    for (const o of assetOverlays) {
      const f = fileById.get(o.fileId);
      if (!f) throw new Error(`Overlay file not found: ${o.fileId}`);
      inputPaths.push(storage.localPath(f.pieceId, f.filename));
      inputOptionArgs.push(await alphaDecodeArgsFor(f));
      assetInputIndex.set(o.id, inputPaths.length - 1);
    }

    // Audio clips get their own -i inputs after the video assets. Each
    // clip's input index maps to the audio filter chain below.
    // Inline clips (kind="inline") linked to this scene represent the
    // scene's own audio track — they're included if enabled.
    // Standalone clips are additional audio sources.
    const clipInputIndex = new Map<string, number>(); // clip.id -> ffmpeg input index
    for (const c of audioClips) {
      if (!c.enabled) continue;
      const f = fileById.get(c.fileId);
      if (!f) throw new Error(`Audio clip file not found: ${c.fileId}`);
      inputPaths.push(storage.localPath(f.pieceId, f.filename));
      inputOptionArgs.push([]); // audio inputs need no video-decoder override
      clipInputIndex.set(c.id, inputPaths.length - 1);
    }

    // Resolve uploaded custom-font file ids referenced by text overlays to
    // their absolute on-disk paths. drawtext renders these via `fontfile=`.
    const fontFileIds = Array.from(
      new Set(
        overlays
          .filter((o): o is Overlay & { fontFileId: string } =>
            o.kind === "text" && typeof (o as { fontFileId?: string }).fontFileId === "string",
          )
          .map((o) => o.fontFileId),
      ),
    );
    const fontPathByOverlayId = new Map<string, string>();
    if (fontFileIds.length > 0) {
      const fontFiles = db.select().from(files).where(inArray(files.id, fontFileIds)).all();
      const fontPathById = new Map(
        fontFiles.map((f) => [f.id, storage.localPath(f.pieceId, f.filename)]),
      );
      for (const o of overlays) {
        if (o.kind !== "text") continue;
        const fid = (o as { fontFileId?: string }).fontFileId;
        if (!fid) continue;
        const p = fontPathById.get(fid);
        if (p) {
          fontPathByOverlayId.set(o.id, p);
        } else {
          logger.warn(
            { tag: "export", op: "export_overlay_render", overlayId: o.id, fontFileId: fid },
            "font file unresolved",
          );
        }
      }
    }

    // `trim` selects a SOURCE range; `duration` is the TIMELINE length. The
    // preview shows whichever is shorter, so the export must cut there too.
    const { start, end, duration } = baseTimeRange(base);

    // Sort overlays by z ascending so the highest z draws last (on top).
    const sorted = [...overlays].sort((a, b) => a.z - b.z);

    // Use the SETTINGS dims for the base scale stage. If the user picked
    // 4K but the composition is 1080p, we scale up to 4K with letterbox
    // padding so the final video file is genuinely 3840×2160. Overlays
    // are still positioned in composition pixel space, so we add an extra
    // scale stage AFTER overlay compositing to upsize the canvas to the
    // target dims.
    const videoFilterChain = buildFilterChain(sorted, assetInputIndex, {
      width: ctx.composition.width,
      height: ctx.composition.height,
      targetWidth: ctx.settings.width,
      targetHeight: ctx.settings.height,
      // A base-shaped video OVERLAY is required to be `fit: "cover"`, and the
      // canvas renderer honours that by CROPPING the overflow (`coverRect`). A
      // legacy base SCENE renders with `fitRect` (contain) instead. Match
      // whichever the preview showed — a contain-padded export of a cover
      // overlay ships black bars where the user saw a full-bleed frame.
      baseFit: base.overlayId != null ? "cover" : "contain",
    }, fontPathByOverlayId);

    // Decide how to handle base audio. The inline AudioClip linked to the BASE
    // (by `linkedOverlayId`) represents the base's own audio track. If one
    // exists and is enabled, include [0:a] in the mix. Otherwise drop base audio.
    const isBaseInlineClip = (c: AudioClip): boolean =>
      c.kind === "inline" && c.linkedOverlayId === base.overlayId;

    const inlineClip = audioClips.find(isBaseInlineClip);
    const keepBaseAudio = inlineClip !== undefined && inlineClip.enabled;
    const baseVolume = keepBaseAudio ? (inlineClip?.volume ?? 1) : 1;

    // Standalone clips (+ inline clips NOT belonging to the base) go through
    // the filter chain as extra audio inputs.
    const standaloneClips = audioClips.filter((c) => c.enabled && !isBaseInlineClip(c));

    // Ducked clips multiply against a pre-rendered gain curve rather than
    // running through an ffmpeg compressor, so the export applies the preview's
    // own duck. See lib/export/duck-envelopes.ts. Envelopes append as inputs
    // after every clip, so existing indices stay valid.
    const clipById = new Map(audioClips.filter((c) => c.enabled).map((c) => [c.id, c]));
    const envelopeInputs: DuckEnvelopeInput[] = [];
    for (const c of standaloneClips) {
      if (!c.duck) continue;
      // Every resolvable sidechain drives the duck; they are summed into one
      // envelope. A sidechain that is missing from the mix is skipped rather
      // than failing — the clip still ducks under the ones that remain.
      const sidechains: PlacedSidechain[] = [];
      for (const scId of duckSidechainIds(c.duck)) {
        const sc = clipById.get(scId);
        const scFile = sc && fileById.get(sc.fileId);
        if (!sc || !scFile) continue;
        sidechains.push({
          path: storage.localPath(scFile.pieceId, scFile.filename),
          startTime: sc.startTime,
          trimStart: sc.trimStart ?? 0,
          duration: sc.duration,
          volume: sc.volume,
        });
      }
      if (sidechains.length === 0) continue; // no sidechain present — mixes undicked
      envelopeInputs.push({ clipId: c.id, duck: c.duck, sidechains });
    }
    const envelopes = await renderDuckEnvelopes({
      inputs: envelopeInputs,
      timelineSeconds: duration,
      outDir: dirname(ctx.outputPath),
    });
    const envelopeIndex = new Map<string, number>();
    for (const [clipId, envPath] of envelopes) {
      inputPaths.push(envPath);
      inputOptionArgs.push([]);
      envelopeIndex.set(clipId, inputPaths.length - 1);
    }

    const audioChainBuild = buildAudioFilterChain({
      keepBaseAudio,
      baseVolume,
      clips: standaloneClips,
      inputIndex: clipInputIndex,
      envelopeIndex,
      // base -ss/-to already trimmed [0:a], so clips use absolute times
      // relative to composition start (= 0).
      sceneDuration: duration,
    });

    // Pick the encoder family for the requested CONTAINER. MP4 + H.264 is the
    // hot path (hardware accel on every platform). WebM requires VP9/Opus —
    // anything else produces a bytewise-mismatched file (H.264-in-WebM that
    // most players refuse).
    const availableEncoders = await detectAvailableEncoders();
    const isWebm = ctx.settings.format === "webm";
    const encoder = isWebm
      ? "libvpx-vp9"
      : (pickEncoder("h264", availableEncoders, process.platform) ?? "libx264");
    const audioCodec = isWebm ? "libopus" : "aac";

    // ffmpeg args:
    //   -ss/-to on the first input trim the base segment (and its audio).
    //   -i for base + each asset input + each audio-clip input.
    //   -filter_complex combines the video chain and (optionally) the audio
    //   chain. Labels [vout] and [aout] are the outputs we map.
    const args: string[] = ["-y"];
    args.push("-ss", String(start), "-to", String(end));
    args.push(...inputOptionArgs[0], "-i", inputPaths[0]);
    for (let i = 1; i < inputPaths.length; i++) {
      args.push(...inputOptionArgs[i], "-i", inputPaths[i]);
    }
    const fullFilterChain = audioChainBuild.chain
      ? `${videoFilterChain};${audioChainBuild.chain}`
      : videoFilterChain;
    args.push("-filter_complex", fullFilterChain);
    args.push("-map", "[vout]");
    if (audioChainBuild.chain) {
      args.push("-map", "[aout]");
    } else if (keepBaseAudio && baseVolume === 1 && standaloneClips.length === 0) {
      // Back-compat: no audio filter graph — preserve base audio directly.
      args.push("-map", "0:a?");
    }
    // else: no audio output at all (no inline clip or disabled, no standalone clips).
    args.push("-c:v", encoder);
    applyVideoQualityFlags(args, encoder, ctx.settings.bitrate);
    args.push("-c:a", audioCodec);
    args.push("-b:a", String(ctx.settings.audioBitrate ?? 256_000));
    args.push("-pix_fmt", "yuv420p");
    // `+faststart` is mp4-only — meaningless to webm and ffmpeg ignores it,
    // but cleaner to omit. Same for libvpx-vp9, which has its own moov-equivalent.
    if (!isWebm) {
      args.push("-movflags", "+faststart");
    }
    args.push(ctx.outputPath);

    let ok = false;
    try {
      await runFfmpeg(args, {
        op: "export_overlay_render",
        context: {
          compositionId: ctx.composition.id,
          baseFileId: base.fileId,
          overlayCount: overlays.length,
          encoder,
        },
        totalDurationSeconds: duration,
        onProgress: ctx.onProgress,
        signal: ctx.signal,
      });

      if (ctx.signal?.aborted) throw new Error("export aborted");

      const data = fs.readFileSync(ctx.outputPath);
      ok = true;
      return {
        blob: new Blob([data], { type: `video/${ctx.settings.format}` }),
        duration,
        format: ctx.settings.format,
      };
    } finally {
      if (!ok) {
        try { fs.unlinkSync(ctx.outputPath); } catch { /* ignore */ }
      }
    }
  }
}

/**
 * Build the filter_complex expression that takes the base video stream
 * ([0:v]) and composites every declarative overlay on top IN Z-ORDER.
 *
 * Always prepends a scale+pad step so the output ALWAYS matches the
 * composition dimensions, using letterbox/pillarbox padding (black).
 * This means a horizontal 1920×1080 base inside a vertical 576×1024
 * composition gets pillarboxed rather than silently producing the wrong
 * output dimensions.
 *
 * Image/video overlays are also scaled to their rect dimensions before
 * being composited so large sources fit inside small rects cleanly.
 *
 * Iterates the caller-sorted overlay list in order (lowest z first, highest z
 * last) and emits one chain segment per overlay so preview (which also
 * composites in z-order via `overlaysActiveAt`) and export stay visually
 * identical. Text overlays use drawtext; image/video overlays use the
 * overlay filter sourced from extra -i inputs.
 *
 * Output label: [vout].
 */
export function buildFilterChain(
  overlays: Overlay[],
  assetInputIndex: Map<string, number>,
  composition: {
    width: number;
    height: number;
    targetWidth?: number;
    targetHeight?: number;
    /** How the BASE fills the frame. `"contain"` (default) letterboxes — what a
     *  legacy base SCENE renders (`fitRect`). `"cover"` scales up and crops the
     *  overflow — what a base-shaped video OVERLAY renders (`coverRect`). */
    baseFit?: "cover" | "contain";
  },
  /** overlay.id → absolute font-file path for text overlays with an uploaded
   *  custom font. When present, drawtext renders via `fontfile=`. */
  fontPathByOverlayId?: Map<string, string>,
): string {
  const W = composition.width;
  const H = composition.height;
  const TW = composition.targetWidth ?? W;
  const TH = composition.targetHeight ?? H;
  // Composite the ENTIRE graph at the target resolution so overlays (drawtext /
  // image / video) rasterize NATIVELY at that resolution — crisp. The old path
  // composited at the logical 1080 then lanczos-upscaled the finished frame,
  // which blurred text/vector edges on a 4K/1440p export. The base video is
  // scaled to the target (a 1080 source can't gain real detail, but it's no
  // worse than before), and every overlay's fontsize/rect is scaled by `scale`.
  const CW = TW;
  const CH = TH;
  const scale = W > 0 ? TW / W : 1;

  // First: fit the base to the COMPOSITE (target) dims, preserving aspect
  // ratio, using the SAME fit policy the canvas renderer used. Output label:
  // [base].
  //   contain (legacy base SCENE, `fitRect`) — scale down + letterbox black.
  //   cover   (base video OVERLAY, `coverRect`) — scale up + centre-crop.
  // Getting this wrong is a visibly wrong frame, not a slow one: a cover
  // overlay exported with contain shows black bars the preview never had.
  const baseChain =
    composition.baseFit === "cover"
      ? `[0:v]scale=${CW}:${CH}:force_original_aspect_ratio=increase,` +
        `crop=${CW}:${CH},` +
        `setsar=1[base]`
      : `[0:v]scale=${CW}:${CH}:force_original_aspect_ratio=decrease,` +
        `pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2:black,` +
        `setsar=1[base]`;

  if (overlays.length === 0) {
    // Passthrough — no overlays (shouldn't happen for ffmpeg-overlay shape,
    // but be defensive). The base is already at target dims.
    return `${baseChain};[base]copy[vout]`;
  }

  const chain: string[] = [baseChain];
  let currentLabel = "base";

  for (let i = 0; i < overlays.length; i++) {
    const o = overlays[i];
    const isLast = i === overlays.length - 1;
    const nextLabel = isLast ? "vout" : `v${i}`;

    if (o.kind === "text") {
      // timeOffset 0: the base is the full clip starting at composition t=0.
      const fontFilePath = fontPathByOverlayId?.get(o.id);
      chain.push(`[${currentLabel}]${drawtextSpecFor(o, 0, fontFilePath, scale)}[${nextLabel}]`);
      currentLabel = nextLabel;
      continue;
    }

    if (o.kind === "image" || o.kind === "video") {
      const inputIdx = assetInputIndex.get(o.id);
      if (inputIdx === undefined) continue;
      // Scale the asset to its (target-scaled) overlay rect before compositing so
      // large sources fit the rect cleanly without overflowing. timeOffset 0.
      chain.push(...assetOverlaySegments(o, inputIdx, currentLabel, nextLabel, String(i), 0, scale));
      currentLabel = nextLabel;
      continue;
    }

    if (o.kind === "tracked") {
      // Should not reach here — classifier gates tracked overlays to the
      // chromium/canvas-source fallback. Emit a passthrough so we don't crash.
      chain.push(`[${currentLabel}]copy[${nextLabel}]`);
      currentLabel = nextLabel;
      continue;
    }

    // `code` overlays should never reach this backend — the classifier gates
    // them to canvas-source. If one slips through, emit a passthrough so we
    // don't crash the pipeline.
    chain.push(`[${currentLabel}]copy[${nextLabel}]`);
    currentLabel = nextLabel;
  }

  // Safety: ensure [vout] exists even if every overlay was skipped (e.g. all
  // asset overlays had missing input indices).
  if (currentLabel !== "vout") {
    chain.push(`[${currentLabel}]copy[vout]`);
  }

  return chain.join(";");
}

/**
 * Build the audio half of the filter_complex graph.
 *
 * Produces a single `[aout]` label that `amix`es the base clip's audio
 * (if `keepBaseAudio`) with each audio track (if any), each per-track
 * filter chain:
 *   - `atrim=0:{duration}` + `asetpts=PTS-STARTPTS` clips to the track's
 *     declared duration (source files may be longer than the composition).
 *   - `adelay={ms}|{ms}` offsets the track relative to the composition
 *     start (stereo-safe syntax).
 *   - `volume={0..1}` scales the track.
 *
 * Returns `{ chain: null }` when no audio sources are in play (keepBaseAudio
 * is false AND tracks is empty) — the caller will simply not emit an
 * audio stream in that case.
 *
 * Edge cases:
 *   - Single amix input is silly (amix does nothing useful with 1 input).
 *     We skip amix entirely in that case and promote the lone per-input
 *     chain directly to `[aout]`.
 *   - `amix=duration=first` ties the mix length to the first input so the
 *     output doesn't stretch when a track outlives the video.
 */
export function buildAudioFilterChain(opts: {
  keepBaseAudio: boolean;
  baseVolume: number;
  clips: AudioClip[];
  inputIndex: Map<string, number>;
  sceneDuration: number;
  /** `clip.id` → input index of its pre-rendered duck envelope, if any. */
  envelopeIndex?: Map<string, number>;
}): { chain: string | null } {
  // Thin adapter over the shared `buildAudioMixGraph`. The single-video path's
  // base scene audio is already time-sliced by -ss/-to, so it maps to the
  // base-audio input; clips mix on top. `duration=first` ties the mix to that
  // full-length base (see buildAudioMixGraph for the multi-scene variant).
  return buildAudioMixGraph({
    baseAudio: opts.keepBaseAudio ? { volume: opts.baseVolume } : null,
    clips: opts.clips,
    inputIndex: opts.inputIndex,
    envelopeIndex: opts.envelopeIndex,
    mixDuration: "first",
  });
}

/**
 * Convert a CSS color string to a form ffmpeg's drawtext `fontcolor`
 * argument accepts: named colors (e.g. `white`), `#RRGGBB`, `#RRGGBBAA`,
 * or `0xRRGGBB`. Anything else would crash the ffmpeg invocation, so
 * we normalize a few common CSS forms up front and fall back to
 * `#ffffff` for unrecognised input rather than aborting the export.
 */
export function cssColorToFfmpeg(color: string): string {
  const trimmed = color.trim();
  if (trimmed.length === 0) return "#ffffff";

  // Hex: #RGB, #RGBA, #RRGGBB, #RRGGBBAA — pass through, expanding shorthand.
  const hexMatch = trimmed.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      // #RGB → #RRGGBB
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    }
    if (hex.length === 4) {
      // #RGBA → #RRGGBBAA
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    }
    if (hex.length === 6 || hex.length === 8) return `#${hex}`;
    return "#ffffff";
  }

  // rgb(r, g, b) / rgba(r, g, b, a) — the a channel comes as 0..1.
  const rgbMatch = trimmed.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([01]?\.?\d+))?\s*\)$/i,
  );
  if (rgbMatch) {
    const r = clampByte(parseInt(rgbMatch[1], 10));
    const g = clampByte(parseInt(rgbMatch[2], 10));
    const b = clampByte(parseInt(rgbMatch[3], 10));
    if (rgbMatch[4] !== undefined) {
      const a = Math.max(0, Math.min(1, parseFloat(rgbMatch[4])));
      const aByte = Math.round(a * 255);
      return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(aByte)}`;
    }
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  // Named CSS color (alphabetic word, e.g. "white") — ffmpeg has its own
  // table; pass through. If ffmpeg doesn't recognise it, the render
  // fails loudly at invocation rather than silently producing the wrong
  // color, which is the correct failure mode here.
  if (/^[a-zA-Z]+$/.test(trimmed)) return trimmed.toLowerCase();

  // hsl() / lab() / etc — fall back to a safe default rather than crash.
  return "#ffffff";
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, n));
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/**
 * Apply codec-specific quality flags. For libx264 this uses an explicit
 * average bitrate + tighter -maxrate/-bufsize so transient high-motion
 * scenes don't run away from VBV, plus -preset slow (better visual quality
 * per bit than the default `medium`) and -profile:v high. Hardware encoders
 * (h264_videotoolbox, h264_nvenc, h264_qsv) just take -b:v + their native
 * quality knob.
 *
 * The default libx264 + medium + no -b:v that the old code path used was
 * the proximate cause of the "video overlays look bad" complaint — ffmpeg
 * fell back to CRF-ish defaults that don't account for the canvas-source
 * style of composited content.
 */
function applyVideoQualityFlags(args: string[], encoder: string, bitrate: number): void {
  const maxrate = Math.round(bitrate * 1.5);
  const bufsize = Math.round(bitrate * 2);
  if (encoder === "libx264") {
    args.push("-preset", "slow");
    args.push("-profile:v", "high");
    args.push("-b:v", String(bitrate));
    args.push("-maxrate", String(maxrate));
    args.push("-bufsize", String(bufsize));
    return;
  }
  if (encoder === "h264_videotoolbox") {
    // VideoToolbox respects -b:v and -allow_sw to fall back if HW path
    // misbehaves. -q:v isn't honored by all builds; -b:v is the safer knob.
    args.push("-b:v", String(bitrate));
    args.push("-maxrate", String(maxrate));
    return;
  }
  if (encoder === "h264_nvenc") {
    args.push("-preset", "p6"); // slow-ish quality preset
    args.push("-rc", "vbr");
    args.push("-b:v", String(bitrate));
    args.push("-maxrate", String(maxrate));
    args.push("-bufsize", String(bufsize));
    return;
  }
  if (encoder === "h264_qsv") {
    args.push("-b:v", String(bitrate));
    args.push("-maxrate", String(maxrate));
    return;
  }
  if (encoder === "libvpx-vp9") {
    // VP9 likes a 2-pass for best quality, but single-pass with explicit
    // bitrate + a reasonable cpu-used is the simpler path and good enough.
    // -row-mt + -tile-columns lets ffmpeg parallelize encoding on multi-core
    // machines, which matters because vp9 is slow.
    args.push("-b:v", String(bitrate));
    args.push("-maxrate", String(maxrate));
    args.push("-cpu-used", "4");
    args.push("-row-mt", "1");
    args.push("-tile-columns", "2");
    return;
  }
  // Unknown encoder — still pass bitrate so output isn't tiny.
  args.push("-b:v", String(bitrate));
}

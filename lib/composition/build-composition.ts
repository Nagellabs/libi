import type { Composition, Overlay, AudioClip } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";
import { pickVideoUrl } from "@/lib/proxy/url";
import { approxLegacyMeasure, normalizeLegacyTextOverlay } from "@/lib/captions/legacy-normalize";

/** Frame used when a caller has no manifest dims (a brand-new piece's
 *  EMPTY_MANIFEST default). Real callers pass the piece's own dims. */
const DEFAULT_FRAME = { width: 1920, height: 1080, fps: 30 } as const;

export interface BuildCompositionOpts {
  /**
   * Every file id known to exist (piece files ∪ global files). When provided
   * together with `filesResolved: true`, a video OVERLAY whose `fileId` is in
   * neither set is flagged `missing` so the preview can show a clear
   * placeholder instead of a silent black frame.
   */
  knownFileIds?: Set<string>;
  /**
   * True once the file queries have settled. Gates missing-detection so a
   * mid-load empty set never false-flags a valid file as deleted.
   */
  filesResolved?: boolean;
  /**
   * Solid frame background (default "#000000"). Painted under every overlay.
   */
  backgroundColor?: string;
  /**
   * The piece's composition dimensions (manifest `width`/`height`/`fps`).
   * Default 1920×1080/30. `width` is load-bearing beyond sizing: legacy text
   * normalization stores `maxWidthPct = rect.width / width`, and the renderer
   * wraps at `composition.width × maxWidthPct` — so this must be the width the
   * composition will actually render at, or text wraps at the wrong place.
   */
  width?: number;
  height?: number;
  fps?: number;
}

/**
 * Hydrate persisted overlay data (JSON on disk) into a runtime Composition
 * with resolved video URLs. Pure — all async resources (images, compiled fns,
 * proxy status) are attached elsewhere.
 *
 * An empty `overlays` array is valid: the composition hydrates to its solid
 * background, NOT null.
 */
export function buildComposition(
  filesById: Map<string, FileRecord>,
  overlays: Overlay[] = [],
  audioClips: AudioClip[] = [],
  opts: BuildCompositionOpts = {},
): Composition {
  const frameWidth = opts.width ?? DEFAULT_FRAME.width;
  // Hydrate-time guard: when an overlay carries a transform3d, ensure the
  // deprecated legacy orientation fields (rotation/flipH/flipV) never leak
  // into the RUNTIME composition even if they survived on-disk (e.g. an
  // older manifest predating the write-through migration). This is a
  // belt-and-suspenders that does NOT mutate the persisted manifest object —
  // it returns shallow copies so the originals are untouched.
  const runtimeOverlays: Overlay[] = overlays.map((raw) => {
    // Lazy legacy-rect normalization: a TEXT overlay missing `anchor` predates
    // the point-text rework — convert it to point text (mid-center + rect
    // center) so all downstream readers see one model. Idempotent. Uses the
    // approximate server measurer (chars * fontSize * 0.5) against the piece's
    // real frame width — see BuildCompositionOpts.width. These are also the
    // wrap inputs the ffmpeg export must reproduce: wrap `content` at
    // `frameWidth × maxWidthPct` with the resolved font (undefined ⇒ no wrap).
    let o =
      raw.kind === "text"
        ? normalizeLegacyTextOverlay(raw, frameWidth, approxLegacyMeasure(raw))
        : raw;
    // Attach the runtime preview URL for VIDEO overlays — the scrub-friendly
    // proxy (1 keyframe/sec) when ready, else the original. Mirrors how video
    // SCENES get `videoUrl`; without it overlays decoded the ORIGINAL (sparse
    // keyframes on AI clips) → slow backward scrubbing. Export still reads the
    // original (the ffmpeg backends never use this field).
    if (o.kind === "video") {
      const file = filesById.get(o.fileId);
      // Confirmed-missing only: the
      // file queries have settled AND the id is absent from the known set
      // (piece ∪ global). A bare `filesById` miss is NOT enough on its own
      // (that map is piece-scoped, so a valid global-file overlay would miss
      // it) and an in-flight load has an empty set that would false-flag
      // every overlay as deleted.
      const missing =
        opts.filesResolved === true &&
        opts.knownFileIds != null &&
        !opts.knownFileIds.has(o.fileId);
      o = {
        ...o,
        videoUrl: file ? pickVideoUrl(file) : `/api/files/by-id/${o.fileId}/content`,
        // Runtime-only source dims — the export classifier needs them to know
        // whether `-c copy` (which cannot scale) would preserve framing. Null
        // when the file is unknown or was never probed; the classifier treats
        // that as a mismatch and takes the re-encoding path.
        sourceWidth: file?.mediaWidth ?? null,
        sourceHeight: file?.mediaHeight ?? null,
        missing,
      };
    }
    // Same confirmed-missing detection for IMAGE overlays — see the `video`
    // branch above for the full rationale. An image overlay whose file was
    // deleted must not render silently: silence is indistinguishable from a
    // genuinely-transparent asset (alpha cutout) or an overlay that hasn't
    // started yet.
    if (o.kind === "image") {
      const missing =
        opts.filesResolved === true &&
        opts.knownFileIds != null &&
        !opts.knownFileIds.has(o.fileId);
      o = { ...o, missing };
    }
    if (!o.transform3d) return o;
    // Shallow copy so we never mutate the persisted manifest object.
    const copy = { ...o } as Record<string, unknown>;
    delete copy["rotation"];
    delete copy["flipH"];
    delete copy["flipV"];
    return copy as unknown as Overlay;
  });

  return {
    id: "composition-1",
    name: "AI Composition",
    width: frameWidth,
    height: opts.height ?? DEFAULT_FRAME.height,
    fps: opts.fps ?? DEFAULT_FRAME.fps,
    overlays: runtimeOverlays,
    audioClips,
    backgroundColor: opts.backgroundColor ?? "#000000",
  };
}

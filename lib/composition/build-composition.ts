import type {
  Composition,
  Scene,
  CanvasScene,
  DrawContext,
  Overlay,
  AudioClip,
} from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";
import type { LayerEffects } from "@/lib/effects/types";
import { createDrawFunction } from "@/lib/ai/scene-validator";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import { pickVideoUrl } from "@/lib/proxy/url";
import { normalizeLegacyTextOverlay } from "@/lib/captions/legacy-normalize";

/** Composition frame width used for legacy-rect normalization. Matches the
 *  hardcoded width in the returned Composition below. */
const FRAME_WIDTH = 1920;

export interface CanvasSceneData {
  id: string;
  type: "canvas";
  name: string;
  duration: number;
  drawFunction: string;
  /** In/out/loop whole-frame animation effects (Ken Burns, etc.). */
  effects?: LayerEffects;
}

/**
 * Persisted scene data as the hydrator receives it. Canvas-only — the video
 * variant was retired (2026-07-19); an imported video hydrates as a full-frame
 * `VideoOverlay` instead.
 */
export type SceneData = CanvasSceneData;

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
   * Solid frame background (default "#000000"). Used by the empty-scenes
   * path where a video-less piece renders bg + overlays.
   */
  backgroundColor?: string;
}

/**
 * Hydrate persisted scene data (JSON on disk) into a runtime Composition
 * with compiled draw functions and resolved video URLs. Pure — all async
 * resources (images, compiled fns, proxy status) are attached elsewhere.
 *
 * An empty `scenes` array is valid: a video-less piece hydrates into a
 * Composition with `scenes: []` (solid background + overlays), NOT null.
 */
export function buildComposition(
  scenes: SceneData[],
  filesById: Map<string, FileRecord>,
  overlays: Overlay[] = [],
  audioClips: AudioClip[] = [],
  opts: BuildCompositionOpts = {},
): Composition {
  const builtScenes: Scene[] = scenes.map((s) => {
    const cs = s;
    let drawFn: CanvasScene["draw"];
    try {
      drawFn = createDrawFunction(cs.drawFunction, DRAW_HELPERS) as unknown as CanvasScene["draw"];
    } catch {
      drawFn = ({ ctx, width, height }: DrawContext) => {
        ctx.fillStyle = "#1a1a2e";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "#ef4444";
        ctx.font = "20px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Error in scene code", width / 2, height / 2);
      };
    }

    return {
      id: cs.id,
      type: "canvas" as const,
      name: cs.name,
      duration: cs.duration,
      draw: drawFn,
      effects: cs.effects,
    } satisfies CanvasScene;
  });

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
    // approximate server measurer (chars * fontSize * 0.5).
    let o =
      raw.kind === "text"
        ? normalizeLegacyTextOverlay(
            raw,
            FRAME_WIDTH,
            (s: string) => s.length * ((raw as Extract<Overlay, { kind: "text" }>).fontSize ?? 48) * 0.5,
          )
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
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: builtScenes,
    overlays: runtimeOverlays,
    audioClips,
    backgroundColor: opts.backgroundColor ?? "#000000",
  };
}

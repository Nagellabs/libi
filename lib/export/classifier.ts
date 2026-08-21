import type { Composition, Overlay } from "@/lib/engine/types";
import { resolveEffect } from "@/lib/effects/registry";
import type { LayerEffects } from "@/lib/effects/types";
import { textUsesThreeInstance } from "@/lib/overlays/three-d-mode";
import { overlayHasKeyframes, overlayHasNonIdentityTransform } from "./overlay-predicates";
import { baseTimeRange, resolveExportBase, streamCopyPreservesFraming } from "./export-base";

export type ExportShape =
  | { tag: "stream-copy-trim" }
  | { tag: "ffmpeg-overlay" }
  | { tag: "chromium-render" }
  | { tag: "canvas-source" }
  | { tag: "error"; reason: string };

/**
 * Default fallback for compositions the ffmpeg server backends can't render.
 * Routes to the new off-browser Chromium renderer by default; honors the
 * `LIBI_EXPORT_USE_BROWSER_CANVAS=1` emergency flag to fall back to the
 * original in-browser MediaBunny CanvasSource pipeline during rollout.
 */
function fallbackShape(): ExportShape {
  return process.env.LIBI_EXPORT_USE_BROWSER_CANVAS === "1"
    ? { tag: "canvas-source" }
    : { tag: "chromium-render" };
}

/**
 * True if any slot of a LayerEffects references a VISUAL effect.
 *
 * Invariant (conservative): an effect ref counts as visual UNLESS it resolves
 * to a known AUDIO-envelope effect (which lowers cleanly to ffmpeg afade). So:
 *   - a resolved built-in/custom visual effect → visual (force canvas-source)
 *   - an UNKNOWN/unregistered effectId         → visual (force canvas-source)
 *   - a resolved audio-envelope effect         → NOT visual (ffmpeg afade OK)
 * The unknown case is deliberately treated as visual: a custom effect may run
 * JS the ffmpeg backends can't reproduce, and the registry on the server may
 * not have that custom loaded at classify time — routing off the ffmpeg fast
 * path to the pixel-perfect canvas renderer is the only safe choice.
 */
function hasVisualEffect(fx: LayerEffects | undefined): boolean {
  if (!fx) return false;
  for (const ref of [fx.in, fx.out, fx.loop]) {
    if (!ref) continue;
    const def = resolveEffect(ref.effectId);
    // Only a RESOLVED audio-envelope effect is non-visual; everything else
    // (resolved visual OR unresolved/unknown) routes off the ffmpeg fast path.
    if (!def || !def.meta.audioEnvelope) return true;
  }
  return false;
}

/**
 * True if any overlay carries a visual effect.
 */
export function compHasVisualEffects(comp: Composition): boolean {
  const overlays = comp.overlays ?? [];
  if (overlays.some((o) => hasVisualEffect((o as { effects?: LayerEffects }).effects))) return true;
  return false;
}

/**
 * True when any overlay or audio clip ends more than one frame after the base
 * video does — i.e. the composition is genuinely longer than the ffmpeg
 * backends' `-to` cut-off, so the fast path would drop that tail.
 */
function outlivesBase(comp: Composition, baseDuration: number): boolean {
  const fps = comp.fps > 0 ? comp.fps : 30;
  const slack = 1 / fps;
  const limit = baseDuration + slack;
  const endsLate = (item: { startTime?: number; duration?: number }) =>
    (item.startTime ?? 0) + (item.duration ?? 0) > limit;
  return (comp.overlays ?? []).some(endsLate) || (comp.audioClips ?? []).some(endsLate);
}

/**
 * Inspect a composition and classify its export shape. Pure.
 *
 * The "base" (ffmpeg input `[0:v]`) comes from `resolveExportBase` — the
 * full-frame, untransformed bottom-z video overlay. Both fast paths below
 * require one; without a base we fall back.
 *
 *   stream-copy-trim — a base video, optional trim, nothing else to
 *     composite, no extra audio tracks: ffmpeg -ss -to -c copy (near-instant).
 *   ffmpeg-overlay   — a base video + declarative overlays in
 *     `comp.overlays[]` (text / image / video kinds, EXCLUDING the base
 *     overlay itself) OR audio clips that require processing (standalone
 *     clips, or inline clips with volume != 1 or enabled=false). The server
 *     backend composites overlays via drawtext + overlay filters and mixes
 *     extra audio via amix. Stream-copy can't mix or mute audio streams.
 *   chromium-render  — default for anything the ffmpeg-overlay backend
 *     can't render server-side: comps with no resolvable base, or comps
 *     containing a `code`-kind overlay in `comp.overlays[]`. Runs off-browser
 *     in headless Chromium.
 *   canvas-source    — emergency fallback (enabled via
 *     `LIBI_EXPORT_USE_BROWSER_CANVAS=1`). Runs in the user's browser
 *     tab via the existing MediaBunny CanvasSource loop.
 */
export function classifyExportShape(comp: Composition): ExportShape {
  // Only a truly-empty piece has nothing to export. The base for the ffmpeg
  // fast paths is a full-frame, untransformed bottom-z video overlay (see
  // lib/export/export-base.ts).
  const hasOverlays = (comp.overlays?.length ?? 0) > 0;
  const hasAudio = (comp.audioClips?.length ?? 0) > 0;
  if (!hasOverlays && !hasAudio) return { tag: "error", reason: "nothing to export" };

  const overlays = comp.overlays;
  const hasCodeOverlay = Array.isArray(overlays) && overlays.some((o) => o.kind === "code");
  const hasTrackedOverlay = Array.isArray(overlays) && overlays.some((o) => o.kind === "tracked");
  const hasThreeOverlay = Array.isArray(overlays) && overlays.some((o) => o.kind === "three");
  // A text overlay that renders through the 3D text instance (3D mode via
  // `place3d`, OR extrusion via `threeD`) goes through three.js (WebGL) and
  // cannot be reproduced by the ffmpeg `drawtext` fast path — treat it like a
  // code/three overlay and force the chromium/canvas fallback. Flat text
  // overlays (neither `place3d` nor `threeD`) keep the drawtext fast path.
  const hasThreeDTextOverlay =
    Array.isArray(overlays) &&
    overlays.some((o) => o.kind === "text" && textUsesThreeInstance(o));
  const hasTransformedOverlay =
    Array.isArray(overlays) && overlays.some(overlayHasNonIdentityTransform);
  // Keyframed overlays animate rect/opacity/transform3d per-frame; the ffmpeg
  // fast path composites statically from the base fields and can't reproduce
  // that motion, so any keyframed overlay forces the canvas/chromium fallback.
  const hasKeyframedOverlay =
    Array.isArray(overlays) && overlays.some(overlayHasKeyframes);
  // Needs re-encode (ffmpeg-overlay) when there are standalone audio clips or
  // inline clips that need volume adjustment / muting. An inline clip linked to
  // the base video overlay with volume=1 and enabled=true is just "keep base
  // audio" — stream-copy handles that transparently. We still need ffmpeg-overlay
  // for any clip that requires audio processing.
  const audioClips = comp.audioClips ?? [];
  // The ONE authority on what `[0:v]` is — shared with both ffmpeg backends so
  // the classifier and the backend can never disagree about the base.
  const base = resolveExportBase(comp);
  // A composited (non-base) image/video overlay with its own trim would need
  // an input-level -ss on its own -i; the overlay filter graph built by
  // `assetOverlaySegments` can't express that (it only scales/crops/overlays
  // the full decoded stream). The BASE overlay's trim is fine — it's handled
  // by `baseTimeRange`/`-ss`/`-to` on input [0:v] by both backends — so this
  // must exclude `base?.overlayId`.
  const hasTrimmedAssetOverlay =
    Array.isArray(overlays) &&
    overlays.some((o) => o.kind === "video" && o.trim != null && o.id !== base?.overlayId);
  const hasAudioTracks = audioClips.some((c) => {
    if (c.kind === "standalone") return true;
    // An inline clip that IS the base overlay's own audio, unmuted and at unity
    // volume, is plain passthrough — stream-copy carries it for free.
    const isBaseAudio = base != null && c.linkedOverlayId === base.overlayId;
    if (c.kind === "inline" && isBaseAudio && c.enabled && c.volume === 1) return false;
    // Any other inline clip (muted, non-unity volume, or another layer's audio)
    // needs the mix graph.
    return true;
  });

  if (base) {
    // The ffmpeg backends end the output at the BASE's end (`-to`). The
    // composition's true length is max(base, overlay ends, audio-clip ends)
    // — see getCompositionFrames — so anything outliving the base would be
    // silently TRUNCATED (a caption tail, an outro sting). Fall back to the
    // renderer, which fills that tail. Allow one frame of slack so a layer
    // that ends "at" the base doesn't trip on float rounding.
    // Measure against the base's CLAMPED output length — the backends cut at
    // `min(trim.end, start + duration)`, so a trim shorter than the layer's
    // timeline duration moves the truncation boundary earlier.
    if (outlivesBase(comp, baseTimeRange(base).duration)) return fallbackShape();

    // Overlays the ffmpeg graph cannot reproduce force the fallback. Checked
    // BEFORE the ffmpeg-overlay/stream-copy split because these apply to both:
    // a code overlay is unrenderable server-side no matter how the base got here.
    if (
      hasCodeOverlay ||
      hasTrackedOverlay ||
      hasThreeOverlay ||
      hasThreeDTextOverlay ||
      hasTransformedOverlay ||
      hasKeyframedOverlay ||
      hasTrimmedAssetOverlay ||
      compHasVisualEffects(comp)
    )
      return fallbackShape();

    // The base overlay itself is not "an overlay to composite" — it IS the base
    // input `[0:v]`. Only OTHER overlays require the filter graph, so a lone
    // base-shaped video overlay still gets the near-instant `-c copy` path.
    const compositedOverlays = (comp.overlays ?? []).filter((o) => o.id !== base.overlayId);
    // `-c copy` ships the source bytes verbatim: it cannot scale, pad, or crop,
    // so it is only valid when the source ALREADY matches the composition's
    // dimensions. When it doesn't (or they're unknown), fall through to
    // ffmpeg-overlay, whose base chain scales the source to the composition —
    // one re-encode instead of a wrong-aspect-ratio file.
    if (compositedOverlays.length > 0 || hasAudioTracks) return { tag: "ffmpeg-overlay" };
    return streamCopyPreservesFraming(base, comp)
      ? { tag: "stream-copy-trim" }
      : { tag: "ffmpeg-overlay" };
  }
  return fallbackShape();
}

import type { AudioClip, Composition } from "@/lib/engine/types";

/**
 * Editor-hidden ("eye toggle") layer semantics — the single source of truth.
 *
 * `overlay.hidden === true` is a PERSISTED authoring property meaning the
 * layer is OFF everywhere, Premiere/AE-style: not rendered (enforced at the
 * `overlaysActiveAt` chokepoint), not decoded (preview source budget), not
 * audible (its COUPLED inline clip is not scheduled), and excluded from
 * export on every backend (the export entry points strip it before
 * classification). It stays on the timeline/layers panel (dimmed) and stays
 * selectable there.
 *
 * Audio predicate: only a COUPLED clip (`kind: "inline"` + `linkedOverlayId`)
 * follows its overlay's eye. A DETACHED clip (`kind: "standalone"` that still
 * carries `linkedOverlayId`) is fully independent — hiding the video does NOT
 * mute it.
 *
 * All helpers are pure with IDENTITY PASSTHROUGH when nothing is hidden, so
 * memo consumers don't churn composition identity — a new identity re-runs
 * the source-registry effect and emits a `comp-identity-change` telemetry
 * mark.
 */

/** Derived hidden-id set, or undefined when nothing is hidden. */
export function hiddenOverlayIdSet(
  overlays: readonly { id: string; hidden?: boolean }[] | undefined,
): ReadonlySet<string> | undefined {
  if (!overlays) return undefined;
  let set: Set<string> | undefined;
  for (const o of overlays) {
    if (o.hidden === true) (set ??= new Set()).add(o.id);
  }
  return set;
}

/** Separator for `hiddenIdSignature` — NUL can't appear in an overlay id. */
const SIGNATURE_SEPARATOR = "\u0000";

/**
 * STABLE primitive signature of the hidden-id set ("" when nothing is hidden;
 * ids sorted). Use it as the memo KEY where a consumer would otherwise depend
 * on the overlays array identity — overlay edits/drags churn that identity
 * every commit, and a set-shaped dependency would rebuild downstream state
 * (e.g. re-reconcile the audio engine's scheduled clips) on edits that never
 * touched hide state. A primitive string compares by value, so the dependent
 * memo recomputes only when the hidden SET actually changes.
 */
export function hiddenIdSignature(
  overlays: readonly { id: string; hidden?: boolean }[] | undefined,
): string {
  const set = hiddenOverlayIdSet(overlays);
  if (!set) return "";
  return [...set].sort().join(SIGNATURE_SEPARATOR);
}

/** Inverse of `hiddenIdSignature` — undefined for the empty signature so
 *  consumers hit the strip helpers' identity passthrough. */
export function hiddenIdSetFromSignature(signature: string): ReadonlySet<string> | undefined {
  return signature ? new Set(signature.split(SIGNATURE_SEPARATOR)) : undefined;
}

/** True when `clip` is the COUPLED audio of a hidden overlay. */
export function isHiddenLinkedAudio(
  clip: Pick<AudioClip, "kind" | "linkedOverlayId">,
  hiddenIds: ReadonlySet<string> | undefined,
): boolean {
  return (
    !!hiddenIds &&
    clip.kind === "inline" &&
    clip.linkedOverlayId != null &&
    hiddenIds.has(clip.linkedOverlayId)
  );
}

/**
 * Core filter, generic over persisted (manifest) and runtime shapes: drop
 * hidden overlays AND their coupled inline audio, deriving the hidden set
 * from the overlays themselves. The export entry points run this BEFORE
 * classification so classifier + backends + render payload all see the same
 * filtered arrays — a hidden base overlay legitimately CHANGES the export
 * shape, and it re-classifies identically everywhere. Identity passthrough
 * on the array refs when nothing hides.
 */
export function stripHiddenLayerArrays<
  O extends { id: string; hidden?: boolean },
  A extends { kind: string; linkedOverlayId?: string | null },
>(
  overlays: O[] | undefined,
  audioClips: A[] | undefined,
): { overlays: O[] | undefined; audioClips: A[] | undefined; changed: boolean } {
  const hiddenIds = hiddenOverlayIdSet(overlays);
  if (!hiddenIds) return { overlays, audioClips, changed: false };
  const nextOverlays = overlays?.filter((o) => o.hidden !== true);
  const nextClips = audioClips?.filter(
    (c) => !isHiddenLinkedAudio(c as Pick<AudioClip, "kind" | "linkedOverlayId">, hiddenIds),
  );
  return { overlays: nextOverlays, audioClips: nextClips, changed: true };
}

/** Composition-level strip (overlays + coupled audio) for the export entry
 *  points (runner, ffmpeg/chromium routes, client router / canvas-source).
 *  Identity passthrough when nothing is hidden. */
export function stripHiddenLayers(composition: Composition): Composition {
  const { overlays, audioClips, changed } = stripHiddenLayerArrays(
    composition.overlays,
    composition.audioClips,
  );
  return changed ? { ...composition, overlays, audioClips } : composition;
}

/**
 * True when the renderer will NEVER advance a decoder for this overlay, so the
 * DECODE pipeline must not mount/gate one:
 *
 * - `hidden === true` (the persisted eye toggle, any kind) — the renderer skips
 *   it at the `overlaysActiveAt` chokepoint, so its `getFrame` never fires.
 * - `missing === true` on a VIDEO source (`kind: "video"`, or a tracked overlay
 *   with video content) — runtime-only flag set by `buildComposition` when the
 *   `fileId` is confirmed absent from piece ∪ global files. The renderer paints
 *   the "media missing" placeholder and returns BEFORE any source lookup, so a
 *   mounted decoder would park forever while the readiness gate keeps grading
 *   it (runway ~0 → the metronomic ~1s re-buffer flap — the `missing` sibling
 *   of the hidden-overlay bug).
 *
 * Deliberately NOT non-decoding: a missing TEXT/IMAGE/CODE/THREE overlay — those
 * mount no video decoder, and the RENDER composition (which this predicate must
 * never filter) keeps them so their placeholder still paints.
 */
export function isNonDecodingOverlay(o: {
  kind?: string;
  hidden?: boolean;
  missing?: boolean;
  /** `string` on text overlays, `{ kind }` on tracked — typed loose to accept `Overlay`. */
  content?: unknown;
}): boolean {
  if (o.hidden === true) return true;
  if (o.missing !== true) return false;
  if (o.kind === "video") return true;
  return (
    o.kind === "tracked" &&
    typeof o.content === "object" &&
    o.content != null &&
    (o.content as { kind?: string }).kind === "video"
  );
}

/**
 * Overlay-only strip for the preview DECODE pipeline (video sources + budget
 * in `use-video-sources`, and the readiness gate probe in `preview-surface`).
 * Drops every non-decoding overlay (see `isNonDecodingOverlay`): hidden layers
 * of any kind, plus confirmed-missing VIDEO sources.
 *
 * Why this must exist: a hidden (or missing) ACTIVE video otherwise keeps a
 * mounted decoder whose request time is only ever advanced by the renderer's
 * `getFrame` — which never fires for it — so its ring parks while the readiness
 * gate keeps grading it against the moving playhead (runway ~0 → the ~1s
 * re-buffer spinner loop whenever that overlay is the dominant source).
 * Filtering it out of the decode composition disposes its source via the
 * registry reconcile and removes it from the gate/dominance math. NEVER feed
 * the result to the renderer — missing overlays must stay in the render
 * composition so their placeholder paints.
 */
export function stripNonDecodingOverlays(composition: Composition | null): Composition | null {
  if (!composition?.overlays) return composition;
  if (!composition.overlays.some(isNonDecodingOverlay)) return composition;
  return { ...composition, overlays: composition.overlays.filter((o) => !isNonDecodingOverlay(o)) };
}

/**
 * The clip set `WebAudioEngine.setClips` should schedule. Identity passthrough.
 *
 * Takes the derived hidden-id SET (not the overlays array) so the caller can
 * key its memo on `hiddenIdSignature(...)` — a primitive — instead of the
 * overlays array identity, which churns on every overlay edit/drag commit and
 * would re-reconcile the audio engine on edits that never touched hide state.
 */
export function stripHiddenAudioClips(
  clips: AudioClip[],
  hiddenIds: ReadonlySet<string> | undefined,
): AudioClip[] {
  if (!hiddenIds || hiddenIds.size === 0) return clips;
  const next = clips.filter((c) => !isHiddenLinkedAudio(c, hiddenIds));
  return next.length === clips.length ? clips : next;
}

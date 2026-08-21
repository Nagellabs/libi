/**
 * Shared types for the hardcoded onboarding piece.
 *
 * `slug` is the ONE identity a media file has here. It is the filename staged
 * on disk, the object name in the public bucket, and the key the composition
 * definition points at. A fileId is a per-install database row id — it means
 * nothing on another machine — so no fileId ever appears in this directory or
 * in anything generated into it. The extractor
 * (`scripts/extract-onboarding-piece.ts`) resolves fileIds once, at extraction
 * time, and emits slugs.
 *
 * `sha256` describes the exact bytes published to the bucket, so a download
 * that got truncated, cached wrong, or silently re-encoded fails loudly
 * instead of producing a subtly broken first-run demo.
 */

import type {
  PersistedAudioClip,
  PersistedOverlay,
} from "@/lib/composition/persistence";
import type { LayerEffects } from "@/lib/effects/types";
import type { CaptionShadow } from "@/lib/engine/types";

export type AssetKind = "video" | "image" | "audio";

/** One media file the onboarding piece needs. `slug` is the stable name used
 *  everywhere — in the definition, in the bucket path, and as the local
 *  filename. Never a fileId. */
export interface OnboardingAsset {
  slug: string;
  kind: AssetKind;
  bytes: number;
  /** Lowercase hex sha256 of the exact bytes published to the bucket. */
  sha256: string;
  contentType: string;
}

/* ------------------------------------------------------------------ *
 * The composition definition
 *
 * Every shape below is DERIVED from the real manifest types rather than
 * re-declared. A hand-copied clone of `PersistedOverlay` would drift the
 * first time someone adds a field to the manifest, and the drift would show
 * up as a silently-dropped property in a generated file nobody re-reads.
 * The only structural change is identity: wherever the manifest names a
 * `fileId`, the definition names an `assetSlug`.
 * ------------------------------------------------------------------ */

/** `T` with its machine-local `fileId` swapped for the portable `assetSlug`.
 *  Distributes over unions, so a union member with no `fileId` passes through
 *  untouched. */
type BySlug<T> = T extends { fileId: string }
  ? Omit<T, "fileId"> & { assetSlug: string }
  : T;

/**
 * Fields the manifest carries on disk that `PersistedOverlay` does not
 * declare. `effects` is the real gap: the runtime `Overlay` has it, the
 * renderer honours it (the end-card title pops in because of it), and it
 * round-trips through `composition.json` — but the persisted union was never
 * given the field. Declaring it here keeps the generated definition faithful
 * without reaching into a shared type this task has no mandate to change.
 *
 * `shadow` is a second, smaller gap: `PersistedOverlay` declares it on TEXT
 * only, which matches the renderer (`drawTextOverlay` is the one place that
 * reads it). The onboarding piece nonetheless carries a `shadow` on one IMAGE
 * overlay, where it draws nothing. It is kept rather than dropped because the
 * definition's job is to reproduce the piece exactly, and a field that renders
 * nothing is a far cheaper mistake than a field silently discarded.
 *
 * NOT included, deliberately: `version`. It is a per-install optimistic-
 * concurrency counter bumped on every save (`saveManifest`), so it means
 * nothing on the machine that downloads this demo — the same reasoning that
 * keeps fileIds out.
 */
interface OnboardingOverlayExtras {
  effects?: LayerEffects;
  shadow?: CaptionShadow;
}

/** One overlay of the film: `PersistedOverlay` by slug, including the slug
 *  swap on a tracked overlay's mounted image/video content. */
type SluggedOverlay<O> = O extends { kind: "tracked"; content: infer C }
  ? Omit<O, "content"> & { content: BySlug<C> }
  : BySlug<O>;

export type OnboardingOverlay = SluggedOverlay<PersistedOverlay> &
  OnboardingOverlayExtras;

/** One narrative beat of the film — a full-frame background layer, named, and
 *  where it sits on the timeline.
 *
 *  Emitted as data by the extractor rather than sniffed back out of the
 *  overlays at read time. The beats were canvas scenes once, so the beat list
 *  was simply the scene list; now they are `code` overlays whose only marker is
 *  a `SLOT X —` prefix on `displayName`, and deriving the user-facing
 *  description from that would let a layer rename silently empty it. */
export interface OnboardingBeat {
  name: string;
  startTime: number;
  duration: number;
}

/** One audio clip of the film, by slug. */
export type OnboardingAudioClip = BySlug<PersistedAudioClip>;

/**
 * Seconds → whole milliseconds, the ONE rounding this feature uses for
 * timeline arithmetic.
 *
 * `39.8 + 12.2` is not exactly `52` in binary floating point, so "does this
 * overlay end at 52.000?" needs a tolerance — and the emitter (which counts
 * how many overlays are held to the end) and the consistency test (which
 * asserts that count is seven) must apply the SAME one. Two spellings of the
 * same tolerance is two chances to disagree about the film's length, which is
 * the failure this whole definition is built to make loud.
 */
export function toMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/** When an overlay or audio clip ends, in whole milliseconds. */
export function endTimeMs(item: { startTime: number; duration: number }): number {
  return toMs(item.startTime + item.duration);
}

/**
 * The whole film, by slug. Structurally a CompositionManifest with every
 * `fileId` replaced by an `assetSlug`, so it is stable across machines.
 *
 * THERE IS NO `tracks` FIELD, and that is a guarantee rather than an omission.
 * The source piece draws slot D's reticle with a real `tracked` overlay over a
 * real object track; the demo draws the identical reticle from boxes baked
 * into a plain `code` overlay's draw function. Object tracking provisions a
 * local model the first time it runs, which a brand-new user has not
 * installed, and a live tracked overlay would put tracking controls in their
 * inspector for a track they cannot regenerate. The extractor is what enforces
 * this (`bakeTrackedOverlay`); leaving the field off the type is what stops it
 * quietly coming back.
 */
export interface OnboardingPieceDefinition {
  version: "v1";
  name: string;
  width: number;
  height: number;
  fps: number;
  beats: OnboardingBeat[];
  overlays: OnboardingOverlay[];
  audioClips: OnboardingAudioClip[];
}

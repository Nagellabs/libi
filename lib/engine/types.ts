/** Core types for the Libi video composition engine */
import type { TrackedContent, TrackFit, TrackSmoothing } from "@/lib/tracking/types";
import type { LayerEffects } from "@/lib/effects/types";
import type { Keyframed } from "./animatable";

/** Context passed to every draw function.
 *
 *  Timing is ELEMENT-LOCAL in every case: for a canvas scene it is the time
 *  within that scene; for a code overlay it is the time within that overlay's
 *  own [startTime, startTime+duration) window (the renderer remaps it — see
 *  lib/engine/overlay-renderer.ts). A draw function therefore animates relative
 *  to its OWN element and the same body works identically in a scene or overlay. */
export interface DrawContext {
  /** Canvas 2D rendering context */
  ctx: CanvasRenderingContext2D;
  /** Composition width in pixels (overlays: the overlay rect width) */
  width: number;
  /** Composition height in pixels (overlays: the overlay rect height) */
  height: number;
  /** Frames per second */
  fps: number;
  /** Total frames in THIS element (scene frames, or overlay-window frames) */
  totalFrames: number;
  /** Current frame number within this element (0-indexed) */
  frame: number;
  /** Current time in seconds within this element */
  time: number;
  /** This element's own duration in seconds. Always populated by the renderer. */
  duration?: number;
  /** Normalized 0→1 progress across this element's window
   *  (clamp(time / duration, 0, 1)). Always populated by the renderer.
   *  Prefer this over `frame`/`totalFrames` for animation pacing. */
  progress?: number;
  /** Loaded assets keyed by asset ID */
  assets: Record<string, HTMLImageElement | HTMLVideoElement | HTMLCanvasElement>;
  /** Caption word timings for THIS overlay (element-local seconds), threaded in
   *  when the overlay carries `caption.words`. A custom code caption body pairs
   *  these with the injected helpers — `activeWordIndex(words, time)`,
   *  `typewriterRevealedText(words, time)`, etc. — to voice-sync accurately
   *  instead of pacing off `progress`. Absent/empty ⇒ not a caption overlay. */
  words?: import("@/lib/captions/types").CaptionCueWord[];
  /**
   * Composition→backing pixel scale (`canvas.width / composition.width`). The
   * renderer applies this as a base ctx transform so all draw code works in
   * logical (composition) pixels while rasterizing at the canvas's backing
   * resolution — full export res on export, display×DPR on preview. Consumers
   * that sample the backing store in device pixels (effect overlays) or size a
   * secondary buffer (three/GL) must multiply by this. Defaults to 1 (legacy:
   * backing == composition), so existing draw code is unaffected.
   */
  renderScale?: number;
}

/** A canvas scene — draws each frame via a JavaScript function */
export interface CanvasScene {
  id: string;
  name: string;
  type: "canvas";
  /** Duration in seconds */
  duration: number;
  /** Draw function called for each frame */
  draw: (context: DrawContext) => void;
  /** In/out/loop whole-frame animations applied to this scene. Absent ⇒ none. */
  effects?: LayerEffects;
}

/**
 * A scene in the composition. Canvas-drawn only — video scenes were retired
 * (2026-07-19); an imported video is a full-frame `VideoOverlay` on
 * `Composition.overlays`, which is editable, transformable and natively
 * compositable by the ffmpeg export backend. Kept as an alias (rather than
 * collapsing every `Scene` reference onto `CanvasScene`) because the SCENE
 * concept itself survives: canvas scenes remain sequential, `sceneOrder`-driven
 * base layers and are in active use.
 */
export type Scene = CanvasScene;

/** Rectangular bounds in composition pixel space (not normalized). */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A 3-component vector. */
export interface Vec3 { x: number; y: number; z: number; }
/** A 3D transform: position and Euler XYZ rotation (radians). `rect` is the single source of truth for size. */
export interface Transform3D { position: Vec3; rotation: Vec3; }

/**
 * Additive per-property keyframe tracks (Phase 2 of the overlay keyframe
 * feature). This is metadata that OVERLAYS the base `rect`/`opacity`/
 * `transform3d` fields — those keep their exact constant types and remain the
 * authored/fallback value. A track present here makes that property animate;
 * absent ⇒ the base field is used verbatim (byte-identical to a non-keyframed
 * overlay). Keyframe `t` is normalized 0→1 within the overlay window. Persisted
 * as plain JSON like `effects` (no per-overlay file). See D1 in the design doc.
 */
export interface OverlayKeyframes {
  rect?: Keyframed<OverlayRect>;
  opacity?: Keyframed<number>;
  transform3d?: Keyframed<Transform3D>;
}

export interface BaseOverlay {
  id: string;
  /** Agent-set display name shown in the timeline track label after the kind
   *  (e.g. "code - Intro Title"). MANDATORY for code/three at creation (the
   *  agent must name them so the user can tell graphics tracks apart); optional
   *  for other kinds (text shows its content, image/video show the file name).
   *  Editable via update_overlay. Not part of the rendered output. */
  displayName?: string;
  /** Start time in seconds (composition-global). */
  startTime: number;
  /** Duration in seconds. */
  duration: number;
  /** Z-order: higher = on top. In the editor this is DERIVED from the
   *  overlay's lane row/sub-lane position (see lib/overlays/lanes.ts), but it
   *  remains the renderer's source of truth for stacking. */
  z: number;
  /** Overlay bounding box (top-left x/y + width/height). For point-text
   *  TextOverlays this is a DERIVED cache computed by
   *  `layoutTextOverlay` (lib/captions/layout.ts) from `position` + `anchor` +
   *  `fontSize` + measured glyphs — not authored directly. */
  rect: OverlayRect;
  /** Opacity 0..1. */
  opacity: number;
  /** 9-point anchor that placement pins (the canvas region the rect snaps to).
   *  Shared by ALL overlay kinds — the inspector Transform tab reads it for every
   *  kind. Text captions default bottom-center, free text / box overlays
   *  mid-center; see lib/captions/types.ts CaptionAnchor and
   *  lib/overlays/anchor-default.ts#defaultAnchorForKind. Absent ⇒ kind default. */
  anchor?: import("@/lib/captions/types").CaptionAnchor;
  /** Horizontal mirror (about the rect center). Canonical flip representation. */
  flipH?: boolean;
  /** Vertical mirror (about the rect center). Canonical flip representation. */
  flipV?: boolean;
  /** Layer OFF everywhere (the eye toggle): not rendered, not decoded, not
   *  audible (its coupled inline audio is muted), and excluded from export on
   *  every backend. Still shown (dimmed) on the timeline/layers panel and
   *  still selectable there. Absent ⇒ visible. Authoring state — persists in
   *  the manifest and snapshots, and round-trips through the agent
   *  (get_overlays / update_overlay). NEVER keyframeable. */
  hidden?: boolean;
  /** Timeline lane group / z-band label. Absent ⇒ derived from kind
   *  (see lib/overlays/lanes.ts#defaultGroupForKind). */
  group?: string;
  /** In/out/loop animations applied to this overlay. Absent ⇒ none. */
  effects?: LayerEffects;
  /** Universal 3D transform: position / Euler-XYZ rotation (radians) / scale.
   *  The SINGLE rotation authority across ALL overlay kinds — in-plane spin lives
   *  on `rotation.z`. Absent ⇒ identity. Flip is separate (`flipH`/`flipV`). */
  transform3d?: Transform3D;
  /** Additive per-property keyframe tracks. Absent ⇒ every animatable property
   *  is a constant (the base field). When a track is present the renderer
   *  resolves that property through `valueAt(keyframes.X ?? baseX, timing)`.
   *  Plain JSON — round-trips through the manifest like `effects`. */
  keyframes?: OverlayKeyframes;
  /** 3D-mode gate. true ⇒ this overlay exposes spatial orientation controls
   *  (transform3d pitch/yaw + z) and the on-canvas orbit gizmo; false/absent ⇒
   *  flat (2D box handles only). Honest, persisted memory for the inspector's
   *  "Make it 3D" switch — stays on even when every angle is zero. `three`
   *  overlays are inherently 3D and ignore this flag. */
  place3d?: boolean;
  /** Monotonic per-overlay version, bumped on every save. Drives the client
   *  edit-store reconcile (drop a pending edit only when the server echoes
   *  version >= the one we wrote). Absent ⇒ treated as 0. */
  version?: number;
  /** Caption-group membership + the per-cue word timings (`caption.words`,
   *  element-local seconds). On ALL kinds — not just text — so a code or three
   *  overlay built to present captions carries the SAME voice-synced timings the
   *  built-in text reveals use (threaded into the draw scope / three update as
   *  `words`). Populated by `generate_captions` (text) or by attaching a file's
   *  transcript to a custom overlay. Absent ⇒ a plain, non-caption overlay. */
  caption?: import("@/lib/captions/types").CaptionGroupRef;
}

/** Rounded background plate drawn behind caption text for readability. */
export interface CaptionBackground { color: string; padding?: number; radius?: number; }
/** Outline stroke around caption glyphs. */
export interface CaptionStroke { color: string; width: number; }
/** Drop shadow behind caption glyphs. */
export interface CaptionShadow { color: string; blur: number; dx?: number; dy?: number; }
/** Per-element reveal animation mode for caption text. */
export type CaptionRevealMode =
  | "none" | "typewriter" | "fade-words" | "slide-up" | "pop"
  | "karaoke"       // full line shown; active word emphasized in highlightColor
  | "word-current"  // only the active word is shown, replaced as time advances
  | "flythrough";   // 3D-only: camera flies along an extruded word, "writing"
                    // each glyph as it passes, ending on the last letter
/** Reveal animation config: mode + the fraction of the window over which it plays. */
export interface CaptionReveal {
  mode: CaptionRevealMode;
  fraction?: number;
  /** Reveal duration in milliseconds — how long the discovery animation
   *  (typewriter / fade-words / slide-up / pop) takes to complete, INDEPENDENT
   *  of the overlay's own duration. When set it wins over `fraction`: the
   *  renderer derives `fraction = durationMs / 1000 / overlayDurationSec` at
   *  draw time, so an 800ms typewriter stays 800ms on an 8s clip. Absent ⇒ fall
   *  back to `fraction` (legacy) or the full window. Time-synced modes
   *  (word-current / karaoke / flythrough) ignore this — they pace off the
   *  whole window by design. */
  durationMs?: number;
  /** Emphasis color for the active word in `karaoke`. Absent ⇒ a default gold. */
  highlightColor?: string;
  /** Paint-on sweep direction (mode "flythrough" only). Absent ⇒ "ltr". */
  direction?: "ltr" | "rtl" | "through";
  /** Camera side-offset for the profile view (mode "flythrough"). Absent ⇒ 1.05.
   *  Larger ⇒ more head-on; smaller ⇒ more edge-on profile. */
  sideOffset?: number;
}
/** Faux/real 3D extrusion config for a text overlay. */
export interface TextThreeD {
  depth: number;
  bevel?: number;
  frontColor?: string;
  sideColor?: string;
  lighting?: "studio" | "soft" | "dramatic" | "flat";
  tilt?: "billboard" | "ground" | "lowAngle" | "highAngle" | "angled";
}

export interface TextOverlay extends BaseOverlay {
  kind: "text";
  /** User-editable text content. */
  content: string;
  font: string;      // e.g. "48px Inter"
  color: string;     // CSS color
  /** Optional uploaded font file (id of a `font`-category file). When set, the
   *  renderer + export resolve a registered/custom family for this overlay;
   *  `font` still supplies size/weight. */
  fontFileId?: string;
  /** "left" | "center" | "right" */
  align: "left" | "center" | "right";
  /** Structured font family (e.g. "Inter"). Composed into `font` when set. */
  fontFamily?: string;
  /** Structured font size in px. Composed into `font` when set. */
  fontSize?: number;
  /** Structured font weight (numeric or keyword). Composed into `font` when set. */
  fontWeight?: number | string;
  /** Line height multiplier for wrapped multi-line captions. */
  lineHeight?: number;
  /** Optional rounded background plate. */
  background?: CaptionBackground;
  /** Optional outline stroke. */
  stroke?: CaptionStroke;
  /** Optional drop shadow. */
  shadow?: CaptionShadow;
  /** Optional reveal animation. */
  reveal?: CaptionReveal;
  // `caption` (group membership + per-cue `words`) is inherited from BaseOverlay
  // so every kind can carry the voice-synced word timings.
  /** Active-word emphasis color for karaoke reveal. Absent ⇒ derived. */
  highlightColor?: string;
  /** When present, text renders as real/faux 3D. Absent ⇒ flat 2D. */
  threeD?: TextThreeD;
  // `anchor` is inherited from BaseOverlay (shared across all overlay kinds).
  /** Authored anchor point in composition pixels: the canvas point where the
   *  `anchor` of the measured text box is pinned. Point-text placement source
   *  of truth — `layoutTextOverlay` derives the box from this + the measured
   *  text. When unset the renderer falls back to the rect-derived anchor point
   *  (anchorPointOf) for not-yet-migrated overlays. */
  position?: { x: number; y: number };
  /** Optional wrap width as a fraction (0..1) of frame width. Unset ⇒ single line
   *  (box hugs the text). */
  maxWidthPct?: number;
}

export interface ImageOverlay extends BaseOverlay {
  kind: "image";
  fileId: string;    // references files.id
  /**
   * True when `fileId` references a file that no longer exists (deleted while
   * the overlay still lives in a snapshot/version). Runtime-only — never
   * persisted. Set by `buildComposition` under the same confirmed-missing gate
   * as `VideoOverlay.missing` (file absent from both piece and global files,
   * and only once both file queries have resolved). Without this flag a
   * deleted image overlay renders nothing, indistinguishable from a
   * genuinely-transparent asset — the renderer instead draws a "media
   * missing" placeholder.
   */
  missing?: boolean;
}

export interface VideoOverlay extends BaseOverlay {
  kind: "video";
  fileId: string;    // references files.id
  /** RUNTIME-ONLY preview decode URL — the scrub-friendly proxy (1 keyframe/sec
   *  → fast backward scrubbing) when ready, else the original. Populated by
   *  `buildComposition` via `pickVideoUrl`; NOT part of the persisted overlay
   *  shape. The export backends always read the ORIGINAL, never this. */
  videoUrl?: string;
  /**
   * True when `fileId` references a file that no longer exists (deleted while
   * the overlay still lives in a snapshot/version). Runtime-only — never
   * persisted. Set by `buildComposition` under a confirmed-missing gate (file
   * absent from both piece and global files, and only once both file queries
   * have resolved). The renderer draws a "media
   * missing" placeholder instead of silently rendering nothing.
   */
  missing?: boolean;
  /** Optional trim relative to the source file. */
  trim?: { start: number; end: number };
  /** How the source frame fills the overlay rect. `"cover"` fills the rect,
   *  cropping overflow (the default — videos added full-frame look like a base
   *  scene); `"contain"` letterboxes to preserve the whole frame. Absent ⇒
   *  `"cover"`. */
  fit?: "cover" | "contain";
  /** RUNTIME-ONLY source pixel dimensions, copied off `files.mediaWidth` /
   *  `files.mediaHeight` by the hydrators (`buildComposition` client-side, the
   *  export routes server-side). NOT part of the persisted overlay shape.
   *  The export classifier reads them to decide whether `-c copy` (which cannot
   *  scale) would preserve the composition's framing — `undefined`/`null` means
   *  UNKNOWN and is treated as a mismatch. */
  sourceWidth?: number | null;
  sourceHeight?: number | null;
}

export interface CodeOverlay extends BaseOverlay {
  kind: "code";
  /** JavaScript function body. Same contract as scene.draw. Compiled via createDrawFunction. */
  drawFunction: string;
}

export interface TrackedOverlay extends BaseOverlay {
  kind: "tracked";
  trackId: string;
  content: TrackedContent;
  fit: TrackFit;
  scale: number;
  smoothing: TrackSmoothing;
  /** Box-size stabilization policy. Absent ⇒ "stabilized" (default): clamps
   *  outlier boxes into the track's median envelope AND median-smooths w/h
   *  over time (~7 frames), holding the offset-implied stable edge fixed —
   *  kills the detector's fast size flap (head ↔ head+neck) and the position
   *  bounce it injects. "raw" = tracker sizes verbatim. */
  sizeMode?: "stabilized" | "raw";
  /** Max factor a frame box may exceed the track median before clamping.
   *  Absent ⇒ 1.75. Only used when stabilized. */
  maxBoxScale?: number;
  /** Render-time position-stabilization policy: "stabilized" (default —
   *  One-Euro filter on the box CENTER; kills tracker bounce, no re-track
   *  needed) or "raw" (follow samples verbatim — deliberate-bounce escape
   *  hatch). Applied in lib/tracking/prepare-overlay-tracks.ts. */
  positionMode?: "stabilized" | "raw";
  /** User "follow offset" — a persistent translation applied AFTER the
   *  track-driven placement (`applyFitAndScale`), in FRACTIONS of the resolved
   *  art box: `{x:0, y:-1}` sits one box-height ABOVE the tracked point (e.g.
   *  above the head). Rides the subject's scale for fit:"tight"/"head"; a
   *  constant px offset for fit:"rect" (whose art box doesn't scale). Absent
   *  ⇒ {0,0}. Written by the preview reposition drag and
   *  libi.update_tracked_overlay. Does NOT modify the track — re-anchoring
   *  (manual anchors / segments) composes independently underneath it. */
  offset?: { x: number; y: number };
}

export interface ThreeOverlay extends BaseOverlay {
  kind: "three";
  /** JS body (build-once). Compiled via createThreeScene with three.js +
   *  a Canvas2D-texture `Text` class injected as named params; returns an
   *  optional per-frame update(frameApi) closure. Never rebuild meshes inside
   *  the closure. */
  sceneFunction: string;
  /** Camera preset applied before the body runs. Default "billboard". */
  cameraPreset?: "billboard" | "ground" | "lowAngle" | "highAngle" | "angled";
}

export type Overlay = TextOverlay | ImageOverlay | VideoOverlay | CodeOverlay | TrackedOverlay | ThreeOverlay;

/** A full video composition — ordered list of scenes */
export interface Composition {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  scenes: Scene[];
  overlays?: Overlay[];
  /** Per-clip audio entries, mixed together at playback. Replaces the
   *  old `audioTracks` shape. */
  audioClips?: AudioClip[];
  /** Solid background fill for the frame, drawn before overlays. Used by the
   *  empty-scenes path (a video-less piece renders bg + overlays). Defaults
   *  to "#000000" when absent. */
  backgroundColor?: string;
}

/** Asset descriptor for user-uploaded or AI-generated assets */
export interface Asset {
  id: string;
  name: string;
  type: "image" | "video" | "svg" | "audio";
  /** URL or data URI */
  url: string;
}

/** Playback state for the preview player */
export interface PlaybackState {
  /** Is currently playing */
  playing: boolean;
  /** Current frame number (global across all scenes) */
  currentFrame: number;
  /** Total frames across all scenes */
  totalFrames: number;
  /** Frames per second */
  fps: number;
}

/** Resolution quality preset. "source" means inherit the composition's
 *  native width/height; "custom" means use the explicit width/height on
 *  ExportSettings. */
export type ExportQuality = "source" | "1080p" | "1440p" | "4k" | "custom";

/** Export settings for video encoding. */
export interface ExportSettings {
  format: "mp4" | "webm";
  codec: "avc" | "vp9" | "av1";
  /** Video bitrate in bits/sec. Derived from quality+resolution if absent. */
  bitrate: number;
  /** Target output width — equals source unless quality is a higher preset. */
  width: number;
  /** Target output height. */
  height: number;
  fps: number;
  /** Quality preset; drives the bitrate ladder + scale stage. Defaults to "source". */
  quality?: ExportQuality;
  /** Audio bitrate in bits/sec. Defaults to 192_000. */
  audioBitrate?: number;
}

/** Result of an export operation */
export interface ExportResult {
  blob: Blob;
  duration: number;
  format: string;
}

/** Frame annotation — user-drawn region on a specific frame */
export interface FrameAnnotation {
  frame: number;
  /** Rectangular region (normalized 0-1 coordinates) */
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** User's note about what to change */
  note: string;
}

/** Sidechain compression parameters. Music clip ducks when sidechain
 *  signal exceeds threshold — same shape feeds Web Audio (preview) and
 *  ffmpeg sidechaincompress (export). */
export interface DuckSettings {
  /** AudioClip id whose envelope drives the duck. Usually a dialogue or
   *  voice-over clip. */
  sidechainClipId: string;
  /** Threshold for the sidechain in dBFS. Below = no compression.
   *  Typical: -30 to -20 dB. */
  thresholdDb: number;
  /** Compression ratio (1..). Higher = more aggressive ducking. */
  ratio: number;
  /** Attack time in ms — how fast the compressor clamps when sidechain
   *  exceeds threshold. */
  attackMs: number;
  /** Release time in ms — how fast the compressor lets go when the
   *  sidechain drops below threshold. */
  releaseMs: number;
  /** Maximum gain reduction in dB (negative = quieter). Caps how far
   *  the music dips at peak. Typical: -12 dB. 0 disables ducking. */
  reductionDb: number;
}

/**
 * Unified audio clip on the composition.
 *
 * `kind: 'inline'` — auto-created when a video OVERLAY with audio is added.
 * Carries `linkedOverlayId` so the timeline shows it under that overlay and
 * edits to the overlay (move / trim / delete) cascade. `linkedSceneId` is the
 * retired video-SCENE spelling, still read for legacy snapshots.
 *
 * `kind: 'standalone'` — user or agent added an audio file (mp3, wav)
 * or detached / duplicated audio from a video.
 */
export interface AudioClip {
  id: string;
  kind: "inline" | "standalone";
  /** File ID — points at an audio file OR a video file (whose audio stream we play). */
  fileId: string;
  /** Composition-global start time in seconds. */
  startTime: number;
  /** How long the clip occupies on the timeline. */
  duration: number;
  /** Offset into the source file in seconds (0 = play from start). */
  trimStart: number;
  /** 0..1 — multiplied with master volume at playback. */
  volume: number;
  /** Speaker toggle on the timeline; false = silent but kept on the timeline. */
  enabled: boolean;
  /** Set when `kind === 'inline'`. The clip follows this scene unless unlinked. */
  linkedSceneId?: string;
  /** Set when `kind === 'inline'` and the clip's audio comes from a video
   *  OVERLAY (not a scene). The clip follows that overlay's timing/trim and is
   *  cascade-removed with it. A clip has at most one of
   *  `linkedSceneId` / `linkedOverlayId`. */
  linkedOverlayId?: string;
  /** Vertical placement of a DETACHED track in the timeline stack — SAME axis as
   *  overlay `z` (higher = nearer the top). Only meaningful for a DETACHED clip
   *  (`kind: 'standalone'` that still carries `linkedOverlayId`): a detached
   *  audio track is fully independent and sorts among the overlay rows by this
   *  key. Coupled (inline) and free (no link) clips ignore it. NEVER affects
   *  render compositing — only the timeline's vertical row order. */
  timelineOrder?: number;
  /** Optional display string ("background music", "intro VO"). */
  label?: string;
  /** When set, this clip is sidechain-compressed by `duck.sidechainClipId`
   *  during playback and export. Phase 2 — see plans/2026-04-23-audio-auto-ducking.md. */
  duck?: DuckSettings;
  /** In/out volume-envelope effects (audio fades). `loop` ignored. Absent ⇒ none. */
  effects?: LayerEffects;
}

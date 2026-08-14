export type TrackMethod = "mediapipe-face" | "mediapipe-object" | "manual" | (string & {});

export interface TrackSample {
  /** Time in seconds from source file start. */
  t: number;
  /** Bbox in source video pixel coordinates. */
  x: number; y: number; w: number; h: number;
  /** 0..1; 0 means "not detected this frame" (we still emit a sample). */
  confidence: number;
  /** Detector said yes for this frame. */
  visible: boolean;
  /**
   * Identity tag from the anchor gate. Null/undefined when no gate applied
   * (Task 10 wires the gate; until then samples leave this undefined).
   */
  subjectId?: string | null;
  /**
   * Cosine similarity of the bound box to the anchor appearance template
   * for this frame. Null/undefined when the appearance gate did not run
   * (motion-only / no ReID / not bound this frame).
   */
  targetSim?: number | null;
}

/** A reference frame + bbox identifying the subject the tracker should follow. */
export interface Anchor {
  fileId: string;
  /** Seconds. */
  time: number;
  /** [x, y, w, h] in source-frame pixels. */
  bbox: [number, number, number, number];
}

export interface TrackAnchorRef extends Anchor {
  /** Optional precomputed embedding (server fills this in). */
  embedding?: number[];
}

/** A user-authored correction: "the subject is HERE at this time". Stored
 *  separately from analysis-derived `anchors`; the agent merges these into
 *  its anchor set but NEVER writes or clears them. */
export interface ManualAnchor {
  /** Deterministic: `man-<round(time*1000)>` — re-dragging the same frame
   *  REPLACES the prior anchor (idempotent, like segment ids). */
  id: string;
  /** Absolute clip time in seconds (frame / fps). */
  time: number;
  /** [x,y,w,h] in the SAME coordinate space as TrackSample. */
  bbox: [number, number, number, number];
  /** ms epoch the anchor was placed. Drives render-stamp CONSUMPTION: a
   *  provenance:"manual" OK segment covering `time` with `createdAt >=`
   *  this means the pin's seeded re-track has landed — the segment is the
   *  pin's truth and the render override skips the raw stamp (see
   *  `isManualAnchorConsumed`). Absent (legacy) ⇒ 0 (any covering manual
   *  segment consumes). */
  createdAt?: number;
}

/** Agent-authored corrective anchor. Structurally mirrors ManualAnchor but is
 *  a SEPARATE channel: written ONLY by compute_track_segment when correcting
 *  an EXISTING track; never written/cleared by the UI; never surfaced as a
 *  user-removable list. Manual anchors outrank these (manual > agent >
 *  engine). See docs-local/superpowers/specs/2026-05-18-agent-anchor-override-design.md. */
export interface AgentAnchor {
  /** Deterministic: `agt-<round(time*1000)>` — re-anchoring the same frame
   *  REPLACES the prior (idempotent), mirroring ManualAnchor. */
  id: string;
  /** Absolute clip time in seconds (frame / fps). */
  time: number;
  /** [x,y,w,h] in the SAME coordinate space as TrackSample. */
  bbox: [number, number, number, number];
}

export interface Track {
  id: string;
  fileId: string;
  /** Optional link to characters/items catalog row. */
  subjectId?: string;
  /** Free-form label shown in the UI ("lisa", "license-plate-1"). */
  label?: string;
  method: TrackMethod;
  /** Samples per second the runner emitted (usually source fps). */
  framerate: number;
  /** Duration covered by samples, in seconds. */
  durationSec: number;
  samples: TrackSample[];
  /** Composable per-range segments. Derived `samples` = stitched union.
   *  Absent on legacy tracks until normalizeTrack() runs. */
  segments?: import("@/lib/tracking/segments").TrackSegment[];
  /** Reference frames identifying the subject. Required at compute time post-Task 8. */
  anchors?: TrackAnchorRef[];
  /** User-authored corrections. UI-owned: agent recompute MERGES these into
   *  its anchor set but never writes/clears this field. See
   *  docs-local/superpowers/specs/2026-05-17-manual-overlay-reanchoring-design.md. */
  manualAnchors?: ManualAnchor[];
  /** Agent-authored corrections. Transparent: written only by
   *  compute_track_segment correcting an existing track; never UI-surfaced.
   *  Manual anchors outrank these at render and as engine seed. */
  agentAnchors?: AgentAnchor[];
}

export type TrackedContent =
  | { kind: "emoji"; char: string }
  | { kind: "text"; content: string; font: string; color: string; align: "left" | "center" | "right" }
  | { kind: "image"; fileId: string }
  | { kind: "video"; fileId: string; trim?: { start: number; end: number } }
  | { kind: "code"; drawFunction: string }
  | { kind: "effect"; op: "blur" | "pixelate" | "mask" };

/** Smoothing kernel applied across consecutive samples. */
export type TrackSmoothing = "linear" | "catmull-rom" | "kalman";

export type TrackFit = "tight" | "head" | "rect";

/**
 * Config injected from the runner into the Playwright page via
 * `page.addInitScript`. Both sides (runner + track-entry) must reference this
 * type so the contract stays in sync.
 */
export interface LibiTrackConfig {
  /** Base URL the page should use to fetch bundled MediaPipe assets. */
  modelBaseUrl: string;
  /**
   * Reference frames identifying the subject. Undefined on the legacy path
   * (no gate); array when the runner-side identity gate should run.
   */
  anchors?: Anchor[];
  /** Job id — page-side runner uses this to poll `/api/jobs/[jobId]/status` for cancel. */
  jobId?: string;
  /** Frame to resume from. Defaults to 0. */
  startFrame?: number;
  /** Samples emitted in a prior run (resume only). */
  priorSamples?: TrackSample[];
}

export type { TrackSegment, SegmentStatus } from "@/lib/tracking/segments";

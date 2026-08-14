export type ShotSize =
  | "extreme-wide" | "wide" | "medium" | "close" | "extreme-close";
export type CameraMotion =
  | "static" | "push-in" | "pull-out" | "pan-left" | "pan-right"
  | "tilt-up" | "tilt-down" | "handheld" | "orbit";

export type Block = {
  id: string;
  kind: "subject" | "prop" | "text" | "inset" | "bg";
  glyph?: string;
  label: string;
  rect: { x: number; y: number; w: number; h: number };
  z: number;
};

export type RenderUnitKind = "satori" | "svg" | "canvas";

/** Which authoring tool the card's Tier-1 render unit uses, and the file
 *  (relative to the card dir) that holds its source. M2 renders it; M1 only
 *  stores the reference. three.js is intentionally absent (deferred). */
export type RenderUnitRef = { kind: RenderUnitKind; file: string };

/** A sketch slot's role. `start`/`end` condition the clip's first/last frame;
 *  `reference` conditions a model reference input (e.g. a style/subject ref image)
 *  — each is bound to a clip-gen param via `SketchSlot.paramKey`. */
export type SketchRole = "start" | "end" | "reference";

/** A role-tagged sketch attached to the clip-gen param it conditions. The
 *  *realized image* is NOT stored here — it lives in `clipGen.params[paramKey]`
 *  (start_frame / end_frame / a reference param). A slot may have no `render`
 *  (a directly-picked image with no sketch). */
export type SketchSlot = {
  id: string;
  role: SketchRole;
  paramKey: string;
  label?: string;
  render?: RenderUnitRef;
  /** An imported image file used AS this slot's sketch, instead of rendering the
   *  `render` unit. When set, it takes precedence over the unit on the serve src. */
  imageFileId?: string;
};

export type GenParamValue = string | number | boolean | string[];

export type GenSpec = {
  apiUrl: string;
  model: string;
  params: Record<string, GenParamValue>;
  /** Epoch ms of the last inline param edit. Drives the "regenerate to apply"
   *  stale hint — compared against the selected take's createdAt. Reset (omitted)
   *  whenever the agent re-authors the whole spec via set_storyboard_generation. */
  editedAt?: number;
};

export type GeneratedClip = {
  id: string;
  fileId: string;
  label: string;        // "v1", "v2", …
  createdAt: number;    // epoch ms
  hidden?: boolean;     // soft-hide (× on the tile); file retained
};

/** A generation input that links live to another card's selected take instead
 *  of holding a fileId. Resolved at read time to that card's selectedClipId. */
export type InheritedRef = { fromCardId: string };

export type StoryboardCard = {
  id: string;
  order: number;
  durationSec: number;
  role: string;
  kind: string;
  title: string;
  description?: string;
  voiceover?: { line: string; voice?: string };
  reuseFromSource?: { fileId: string; startSeconds: number; endSeconds: number };
  sceneId?: string;
  // Tier 1 — ordered sketch slots (start, end, references)
  sketches: SketchSlot[];
  blocks?: Block[];
  camera: { shot: ShotSize; motion?: CameraMotion };
  promptFragment: string;
  // Tier 2/3
  keyframeFileId?: string;
  clipFileId?: string;
  stage: "schematic" | "keyframe" | "clip";
  approvals: { schematic?: boolean; keyframe?: boolean; clip?: boolean };
  cost?: { keyframeUsd?: number; clipUsd?: number };
  characterId?: string;
  keyframeGen?: GenSpec;
  clipGen?: GenSpec;
  clips?: GeneratedClip[];
  selectedClipId?: string;
  // param-key → inherited link (e.g. { reference_video: { fromCardId } })
  inheritedRefs?: Record<string, InheritedRef>;
};

export type StoryboardEdge = { from: string; to: string };

/** Manifest = ordering + edges + overview. Card payloads live in their own
 *  files (context-efficient agent editing). */
export type StoryboardManifest = {
  version: 2;
  overview?: string;
  cardOrder: string[];
  edges?: StoryboardEdge[];
  updatedAt: string;
  budgetUsd?: number;
  layout?: { positions: Record<string, { x: number; y: number }> };
};

/** In-memory composed view: manifest + resolved cards. */
export type Storyboard = StoryboardManifest & { cards: StoryboardCard[] };

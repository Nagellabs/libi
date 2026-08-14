/**
 * Inspector field registry — the single source of truth for which overlay
 * inspector controls exist, for which overlay kind, and in which intent
 * *group* (control-group tab) each renders.
 *
 * **Control-group model (per-kind intent groups).** The inspector tab axis is
 * INTENT, not complexity. A field belongs to one of three groups —
 * `transform` (where/how-big/how-rotated), `style` (how-it-looks), `text`
 * (what-it-says / typography). A tab renders ONLY the fields whose group (for
 * that kind) EQUALS the active tab. The registry is one entry per **(key,
 * kind)** pair (generic transform keys are repeated per kind). Within a group a
 * field may carry `advanced: true` for in-group progressive disclosure (the
 * inspector hides advanced fields behind an "Advanced ▾" reveal); the group it
 * renders on is unchanged.
 *
 * One module drives four things:
 *  1. Group gating (`groupForField(key, kind) === activeGroup`, consumed by `<GroupField>`).
 *  2. Highlight targeting (the `key` is the `data-field` value the highlight
 *     store matches against, and `groupForField` says which tab to reveal).
 *  3. MCP `highlight_property` validation (the valid property-key set via
 *     `isKnownFieldKey`).
 *  4. The `guiding-manual-edits` skill key list (derived from this table).
 *
 * The `inspector-fields-coverage.test.ts` coverage test enforces two-way
 * parity between this registry and the actually-rendered `[data-field]`
 * elements, so adding/renaming/regrouping a field without updating this table
 * fails the suite. Keep `key` values EXACTLY as the spec table lists them —
 * they are public property keys shared across the tool + skill + UI.
 */

/** Intent group — the inspector tab axis. NOT complexity. `anchors` is the
 *  tracked-only manual re-anchor management tab (a custom panel marked by the
 *  single `trackAnchors` key, not value fields). */
export type InspectorGroup = "transform" | "style" | "text" | "3d" | "anchors";

export type InspectorOverlayKind =
  | "text"
  | "image"
  | "video"
  | "code"
  | "three"
  | "tracked";

export interface InspectorFieldDef {
  /** Stable property key, e.g. "background.color", "reveal.mode", "content". */
  key: string;
  /** Human label used in highlight callouts. */
  label: string;
  /** Section id grouping the field in the inspector. */
  section: string;
  /** The single overlay kind this entry applies to. */
  kind: InspectorOverlayKind;
  /** The intent group (tab) this field belongs to for this kind. */
  group: InspectorGroup;
  /** When true, the field is hidden behind the group's "Advanced ▾" reveal. */
  advanced?: boolean;
}

/** Canonical group ordering (the inspector tab order). Text leads for text
 *  overlays — what it says comes first — then Style, Transform, 3D. Non-text
 *  kinds only have the Transform group, so this reorder is a no-op for them
 *  (groupsForKind filters to the groups a kind actually has). */
export const GROUP_ORDER: InspectorGroup[] = ["text", "style", "transform", "3d", "anchors"];

const GROUP_RANK: Record<InspectorGroup, number> = {
  text: 0,
  style: 1,
  transform: 2,
  "3d": 3,
  anchors: 4,
};

export function groupRank(group: InspectorGroup): number {
  return GROUP_RANK[group];
}

/**
 * Map a registry `section` id to its intent group. The single source of truth
 * for the section→group assignment. Sections present in the registry:
 *   transform group: position, rotation, transform, camera
 *   style group:     style, background, stroke, shadow, reveal
 *   text group:      content, font
 *   3d group:        three-d
 */
export function groupForSection(section: string): InspectorGroup {
  switch (section) {
    case "position":
    case "rotation":
    case "transform":
    case "camera":
      return "transform";
    case "style":
    case "background":
    case "stroke":
    case "shadow":
    case "reveal":
      return "style";
    case "content":
    case "font":
      return "text";
    case "three-d":
      return "3d";
    case "anchors":
      return "anchors";
    default:
      // Unknown section ⇒ best-fit transform (placement is the safe default).
      return "transform";
  }
}

/**
 * Generic transform/timing keys shared by every kind. Each kind names the keys
 * it includes (every generic key lands in the `transform` group via its
 * section). An optional `advanced` set marks which of those keys hide behind
 * the in-group "Advanced ▾" reveal.
 */
type GenericKeys = { keys: string[]; advanced?: string[] };

function genericEntries(
  kind: InspectorOverlayKind,
  spec: GenericKeys,
  labels: Record<string, string>,
  sections: Record<string, string>,
): InspectorFieldDef[] {
  const advanced = new Set(spec.advanced ?? []);
  return spec.keys.map((key) => ({
    key,
    label: labels[key],
    section: sections[key],
    kind,
    group: groupForSection(sections[key]),
    advanced: advanced.has(key) || undefined,
  }));
}

// Shared labels/sections for the generic transform/timing keys. There is no
// `group` (lane) field — lanes are assigned automatically by the editor and
// changed by dragging the track, not via an inspector control.
const GENERIC_LABELS: Record<string, string> = {
  position: "Position",
  size: "Size",
  opacity: "Opacity",
  rotation: "Rotation",
  zOrder: "Layer order",
  flipH: "Flip horizontal",
  flipV: "Flip vertical",
  startTime: "Start time",
  endTime: "End time",
  // Unified 3D transform panel (text/image/video/code/tracked).
  transformPosX: "Position X",
  transformPosY: "Position Y",
  transformPosZ: "Depth (Z)",
  transformSpin: "Spin",
  transformSize: "Size",
  // "Make it 3D" gate (the place3d toggle) — present on every flat kind's 3D
  // group; `three` is inherently 3D and gets no toggle.
  place3d: "Make it 3D",
};
const GENERIC_SECTIONS: Record<string, string> = {
  position: "position",
  size: "position",
  opacity: "transform",
  rotation: "rotation",
  zOrder: "transform",
  flipH: "transform",
  flipV: "transform",
  startTime: "transform",
  endTime: "transform",
  transformPosX: "position",
  transformPosY: "position",
  transformPosZ: "position",
  transformSpin: "rotation",
  transformSize: "position",
  place3d: "three-d",
};

// The unified Transform panel splits into two intent groups (universal-3D
// controls): the always-on PLANAR (2D) controls live in the `transform` group,
// while the out-of-plane SPATIAL controls move to the `3d` group behind the
// "Make it 3D" (`place3d`) gate. Shared by the four non-three flat kinds.
const PLANAR_TRANSFORM_KEYS = [
  "transformPosX",
  "transformPosY",
  "transformSpin",
  "transformSize",
] as const;

/**
 * The `3d`-group rows for a flat kind: the `place3d` toggle, the Pose preset
 * grid, the rotation dial (`transform3d.rotation` — Angle/Elevation/Spin
 * circles + editable inputs), then Depth-Z. Rendered on the 3D tab (the
 * per-row explicit `group:"3d"` overrides the section→group mapping that would
 * otherwise place rotation/position keys in `transform`).
 */
function threeDEntries(kind: InspectorOverlayKind): InspectorFieldDef[] {
  return [
    { key: "place3d", label: GENERIC_LABELS["place3d"], section: "three-d", kind, group: "3d" },
    { key: "transform3d.pose", label: "Pose", section: "three-d", kind, group: "3d" },
    { key: "transform3d.rotation", label: "Rotation", section: "three-d", kind, group: "3d" },
    { key: "transformPosZ", label: GENERIC_LABELS["transformPosZ"], section: GENERIC_SECTIONS["transformPosZ"], kind, group: "3d" },
  ];
}

// code / image / video generic (transform group) set. zOrder + timing hide
// behind the in-group "Advanced ▾" reveal; opacity + the PLANAR position panel
// are the common (always-visible) controls. The spatial keys live in the 3D
// group (see threeDEntries) — not here.
const NON_TEXT_GENERIC: GenericKeys = {
  keys: ["opacity", "zOrder", "startTime", "endTime", ...PLANAR_TRANSFORM_KEYS],
  advanced: ["zOrder", "startTime", "endTime"],
};

const VIDEO_GENERIC: GenericKeys = {
  keys: ["opacity", ...PLANAR_TRANSFORM_KEYS],
};

// tracked renders the shared planar TransformFields in its kind-aware shape:
// Size (the uniform `scale` multiplier — the SAME field the preview corner
// handles write) + Spin, plus the follow-offset rows below. There is NO
// Position X/Y (and no anchor pad): tracked placement is track-driven —
// `resolveTrackedRect` never reads `rect.x/y` — and repositioning goes through
// the follow offset (`offsetX`/`offsetY`). The legacy out-of-plane keys
// (Angle/Elevation/Depth-Z) were registry-only phantoms — nothing rendered
// them — and were removed when the coverage test started enforcing tracked
// parity.
const TRACKED_GENERIC: GenericKeys = {
  keys: ["opacity", "zOrder", "startTime", "endTime", "transformSpin", "transformSize"],
  advanced: ["zOrder", "startTime", "endTime"],
};

/**
 * The authoritative per-(key,kind) group table. Every field carries an intent
 * group derived from its `section`; the per-group coverage test enforces the
 * registry↔render parity.
 */
export const INSPECTOR_FIELDS: InspectorFieldDef[] = [
  // ── text (tabs: Text, Style, Transform, 3D) ────────────────────────────
  // Text group — content + typography.
  { key: "content", label: "Text", section: "content", kind: "text", group: "text" },
  { key: "fontFamily", label: "Font family", section: "font", kind: "text", group: "text" },
  { key: "fontWeight", label: "Font weight", section: "font", kind: "text", group: "text" },
  { key: "align", label: "Alignment", section: "font", kind: "text", group: "text" },
  // Caption Size lives ONLY on the Transform tab (font size IS the caption's
  // size). It used to also appear on Text as a mirror; that duplicate was
  // removed, so its single registry home is now the transform group.
  { key: "fontSize", label: "Size", section: "font", kind: "text", group: "transform" },
  // Style group — preset + look.
  { key: "style", label: "Style preset", section: "style", kind: "text", group: "style" },
  { key: "color", label: "Color", section: "style", kind: "text", group: "style" },
  { key: "background", label: "Background", section: "background", kind: "text", group: "style" },
  { key: "background.color", label: "Background color", section: "background", kind: "text", group: "style" },
  { key: "background.padding", label: "Background padding", section: "background", kind: "text", group: "style" },
  { key: "background.radius", label: "Background radius", section: "background", kind: "text", group: "style" },
  { key: "stroke", label: "Stroke", section: "stroke", kind: "text", group: "style" },
  { key: "shadow", label: "Shadow", section: "shadow", kind: "text", group: "style" },
  // NOTE: text reveal (typewriter / karaoke / paint-on …) is NOT an inspector
  // field — it lives in the Effects panel's "Reveal" family tab (single-select
  // over `overlay.reveal`). See lib/captions/reveal-modes.ts + effects-panel.
  // 3D group — extrusion toggle + primary geometry/tilt; fine controls hide
  // behind Advanced; plus the four 3D rotation/Z transform keys (the orbit
  // gizmo's manual-angle accordion), all advanced.
  { key: "text3dEnabled", label: "3D", section: "three-d", kind: "text", group: "3d" },
  // Extrusion depth → labelled "Thickness" in the UI (avoids colliding with the
  // spatial "Depth" / transformPosZ row). The registry key stays text3dDepth.
  { key: "text3dDepth", label: "Thickness", section: "three-d", kind: "text", group: "3d" },
  // (The extrusion "Camera" preset grid — text3dTilt — was removed from the UI;
  // orientation is driven solely by the unified Pose grid + rotation dial, which
  // the extruded-text builder honors via transform3d.rotation.)
  // Extrusion fine controls — now flat (no Advanced disclosure); shown disabled
  // when Extrude is off.
  { key: "text3dBevel", label: "3D bevel", section: "three-d", kind: "text", group: "3d" },
  { key: "text3dFrontColor", label: "3D front color", section: "three-d", kind: "text", group: "3d" },
  { key: "text3dSideColor", label: "3D side color", section: "three-d", kind: "text", group: "3d" },
  { key: "text3dLighting", label: "3D lighting", section: "three-d", kind: "text", group: "3d" },
  // Reset-3D button (parity with the `three` 3D tab). Registered so the rendered
  // [data-field] matches the registry.
  { key: "transform.reset", label: "Reset 3D", section: "three-d", kind: "text", group: "3d" },
  // "Make it 3D" gate — the place3d toggle. Promotes the caption into 3D mode
  // (orbit gizmo + on-surface Angle/Elevation/Depth-Z). Extrusion (text3d*) is a
  // further opt-in within the same gate.
  { key: "place3d", label: GENERIC_LABELS["place3d"], section: "three-d", kind: "text", group: "3d" },
  // 3D orientation — the Pose preset grid + the rotation dial (Angle yaw /
  // Elevation pitch / Spin roll circles + editable inputs), then Depth-Z. On the
  // surface, gated by the place3d "Make it 3D" toggle. (text ALSO keeps its
  // always-on 2D `rotation` "Rotate" spin control in the Transform group.)
  { key: "transform3d.pose", label: "Pose", section: "three-d", kind: "text", group: "3d" },
  { key: "transform3d.rotation", label: "Rotation", section: "three-d", kind: "text", group: "3d" },
  { key: "transformPosZ", label: GENERIC_LABELS["transformPosZ"], section: GENERIC_SECTIONS["transformPosZ"], kind: "text", group: "3d" },
  // Transform group — placement, in-plane rotate (writes transform3d.rotation.z),
  // opacity, z-order, timing + the in-plane Position X/Y panel. The 3D rotation/Z
  // keys above live in the 3D group; only X/Y stay here for text. There is NO
  // `transformSize` (uniform scale) for text: `fontSize` IS the caption's single
  // size control (in this Transform tab as a mirror + in the Text tab).
  { key: "rotation", label: "Rotate", section: "transform", kind: "text", group: "transform" },
  { key: "opacity", label: "Opacity", section: "transform", kind: "text", group: "transform" },
  { key: "zOrder", label: "Layer order", section: "transform", kind: "text", group: "transform", advanced: true },
  { key: "startTime", label: "Start time", section: "transform", kind: "text", group: "transform", advanced: true },
  { key: "endTime", label: "End time", section: "transform", kind: "text", group: "transform", advanced: true },
  { key: "transformPosX", label: GENERIC_LABELS["transformPosX"], section: GENERIC_SECTIONS["transformPosX"], kind: "text", group: "transform" },
  { key: "transformPosY", label: GENERIC_LABELS["transformPosY"], section: GENERIC_SECTIONS["transformPosY"], kind: "text", group: "transform" },
  // NB: text uses `rotation` (above) as its single in-plane spin control. The
  // generic `transformSpin` key (used by image/video/code, which have no
  // `rotation` field) is intentionally NOT registered for text — it would be a
  // duplicate that writes the same transform3d.rotation.z.

  // ── three (tabs: Transform [2D rect] + 3D [scene transform]) ───────────
  // three is inherently 3D (no place3d toggle). Its 2D rect/size/opacity stay in
  // the transform group (via genericEntries below); the scene transform + camera
  // move to the 3D group so a Transform/3D tab bar appears.
  // Pose preset grid — snaps orientation (rotation) to a recognizable pose.
  // Replaced the old `camera` (three.js camera-position) control.
  { key: "transform3d.pose", label: "Pose", section: "three-d", kind: "three", group: "3d" },
  { key: "transform.reset", label: "Reset transform", section: "transform", kind: "three", group: "3d" },
  { key: "transform3d.rotation", label: "Rotation (3D)", section: "transform", kind: "three", group: "3d" },
  // Depth (position.z) — the single remaining position control after the
  // per-axis Pos X/Y rows were dropped in the unified-3D vocabulary.
  { key: "transform3d.position", label: "Depth (Z)", section: "transform", kind: "three", group: "3d" },
  // Size = rect window W/H (the generic SizeField), identical to image/video/code.
  { key: "size", label: "Size", section: "transform", kind: "three", group: "transform" },
  ...genericEntries(
    "three",
    {
      keys: [
        "opacity",
        "rotation",
        "position",
        "zOrder",
        "flipH",
        "flipV",
        "startTime",
        "endTime",
      ],
      // rotation/position render in the always-visible (common) area of
      // ThreeTransformPlanar (size is the explicit `size` entry above) — only
      // flipH/flipV (plus the timing keys) sit behind the Advanced reveal, so
      // the advanced set is honest.
      advanced: [
        "zOrder",
        "flipH",
        "flipV",
        "startTime",
        "endTime",
      ],
    },
    GENERIC_LABELS,
    GENERIC_SECTIONS,
  ),

  // ── image (tabs: Transform [planar] + 3D [place3d gate]) ───────────────
  ...genericEntries("image", NON_TEXT_GENERIC, GENERIC_LABELS, GENERIC_SECTIONS),
  ...threeDEntries("image"),

  // ── code (tabs: Transform [planar] + 3D [place3d gate]) ────────────────
  ...genericEntries("code", NON_TEXT_GENERIC, GENERIC_LABELS, GENERIC_SECTIONS),
  ...threeDEntries("code"),

  // ── tracked (tabs: Transform + Anchors) ──────────────────────────────────
  ...genericEntries("tracked", TRACKED_GENERIC, GENERIC_LABELS, GENERIC_SECTIONS),
  // Follow offset — reposition the content relative to the tracked placement
  // (fractions of the resolved box; the drag gesture writes the same field).
  { key: "offsetX", label: "Follow offset X", section: "position", kind: "tracked", group: "transform" },
  { key: "offsetY", label: "Follow offset Y", section: "position", kind: "tracked", group: "transform" },
  // Anchors tab — the manual re-anchor management surface (list + jump /
  // staged delete / re-track), relocated from the old bottom ManualEditsPanel.
  // ONE key marks the whole custom panel; it is not a value field. The
  // drag-to-re-anchor GESTURE stays on the preview ("Adjust tracking").
  { key: "trackAnchors", label: "Manual re-anchors", section: "anchors", kind: "tracked", group: "anchors" },

  // ── video (tabs: Transform [planar] + 3D [place3d gate]) ───────────────
  ...genericEntries("video", VIDEO_GENERIC, GENERIC_LABELS, GENERIC_SECTIONS),
  ...threeDEntries("video"),
];

/**
 * The def for a (key, kind) pair, or undefined when the key is not applicable
 * to that kind. `kind` is optional: omit it for legacy callers that only need
 * "the first def for this key across any kind" (used by drift checks).
 */
export function findField(
  key: string,
  kind?: InspectorOverlayKind,
): InspectorFieldDef | undefined {
  if (kind === undefined) {
    return INSPECTOR_FIELDS.find((f) => f.key === key);
  }
  return INSPECTOR_FIELDS.find((f) => f.key === key && f.kind === kind);
}

/** The group a field renders in for a given kind, or undefined if not applicable. */
export function groupForField(
  key: string,
  kind: InspectorOverlayKind,
): InspectorGroup | undefined {
  return findField(key, kind)?.group;
}

/**
 * True when `key` appears for ANY kind. Used for drift detection (an unknown
 * key is a registry error) — distinct from per-kind applicability, which a
 * caller checks via `groupForField(key, kind)`.
 */
export function isKnownFieldKey(key: string): boolean {
  return INSPECTOR_FIELDS.some((f) => f.key === key);
}

/**
 * The group (tab) a field belongs to for a kind — i.e. the tab to reveal when
 * highlighting it. Returns undefined when the field is not applicable to the
 * kind (or the key is unknown).
 */
export function targetGroupForField(
  key: string,
  kind?: InspectorOverlayKind,
): InspectorGroup | undefined {
  return findField(key, kind)?.group;
}

/** Every field key applicable to the given overlay kind (across all its groups). */
export function fieldKeysForKind(kind: InspectorOverlayKind): string[] {
  return INSPECTOR_FIELDS.filter((f) => f.kind === kind).map((f) => f.key);
}

/** Field keys for a specific (kind, group) — the keys rendered on that one tab. */
export function fieldKeysForKindGroup(
  kind: InspectorOverlayKind,
  group: InspectorGroup,
): string[] {
  return INSPECTOR_FIELDS.filter(
    (f) => f.kind === kind && f.group === group,
  ).map((f) => f.key);
}

/**
 * The `advanced: true` field keys for a specific (kind, group) — the keys that
 * hide behind that tab's in-group "Advanced ▾" reveal. Drives suppression of an
 * empty Advanced disclosure: a call site intersects its own advanced slot keys
 * with this set to decide whether the toggle should render at all.
 */
export function advancedFieldKeysForKindGroup(
  kind: InspectorOverlayKind,
  group: InspectorGroup,
): string[] {
  return INSPECTOR_FIELDS.filter(
    (f) => f.kind === kind && f.group === group && f.advanced === true,
  ).map((f) => f.key);
}

/**
 * The ordered, distinct groups that have ≥1 field for the kind (canonical
 * order text → style → transform → 3d → anchors). A kind's available tabs.
 */
export function groupsForKind(kind: InspectorOverlayKind): InspectorGroup[] {
  const present = new Set(
    INSPECTOR_FIELDS.filter((f) => f.kind === kind).map((f) => f.group),
  );
  return GROUP_ORDER.filter((g) => present.has(g));
}

/** The default (first) group for a kind — the initial active tab. */
export function defaultGroupForKind(kind: InspectorOverlayKind): InspectorGroup {
  const groups = groupsForKind(kind);
  return groups[0] ?? "transform";
}

/** True when a kind has more than one group (so a tab selector should render). */
export function hasGroupsForKind(kind: InspectorOverlayKind): boolean {
  return groupsForKind(kind).length > 1;
}

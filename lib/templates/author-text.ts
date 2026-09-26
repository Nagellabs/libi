/**
 * A stranger's words in a template, field by field.
 *
 * Applying a public or installed template copies its scaffold into the user's
 * piece, and every piece and file tool (`get_composition`, `list_files`,
 * `get_piece_state`, the layers panel) hands that piece back later with no
 * label — as if the user had written it. So every string a scaffold can hold
 * is classified here, and `applyScaffold` (materialize.ts) applies the
 * classification to any template that is not the user's own:
 *
 *  - **kept** — the template itself: the text its layers show, and font
 *    families. The apply result labels these (`authorFields.inPiece`).
 *  - **neutralised** — replaced by a name libi makes up, dropped, or kept only
 *    when it is one of a closed set of values the renderer understands (a CSS
 *    colour, a known effect, an easing preset), so no free text survives.
 *  - **not copied** — never reaches the piece: ids are minted afresh, links
 *    are rewritten to them, and the listing's metadata stays in the catalog.
 *
 * The audit test (`__tests__/unit/templates/author-text.test.ts`) walks the
 * scaffold schema and fails on any string this table does not classify, so a
 * field added to the schema later has to be decided on here first.
 */
import type { CaptionRevealMode, TextThreeD } from "@/lib/engine/types";
import { EASING_PRESETS } from "@/lib/engine/easing-registry";
import { findEffect } from "@/lib/effects/registry";
import { refreshCustomEffects } from "@/lib/effects/packages";
import { defaultGroupForKind } from "@/lib/overlays/lanes";

export type AuthorTextTreatment = "kept" | "neutralised" | "not-copied";

const kept = (note: string) => ({ treatment: "kept" as const, note });
const neutralised = (note: string) => ({ treatment: "neutralised" as const, note });
const notCopied = (note: string) => ({ treatment: "not-copied" as const, note });

const COLOUR = neutralised("kept only when it is a CSS colour (hex, a colour function of numbers, color(), color-mix() of colours, or a CSS colour name); otherwise dropped");
const EFFECT_ID = neutralised("kept only when it names an effect libi has; otherwise that effect is dropped");
const EFFECT_PARAM_KEY = neutralised("kept only when the effect declares that param; otherwise dropped");
const EFFECT_PARAM_VALUE = neutralised("a string is kept only when it is one of the param's enum options, or a CSS colour for a colour param");
const EASING = neutralised("kept only when it is an easing preset id or a numeric cubic-bezier(); otherwise dropped (linear)");
const REVEAL_MODE = neutralised("kept only when it is a reveal mode libi renders; otherwise the reveal is dropped");
const FONT_WEIGHT = neutralised("a string is kept only when it is normal, bold, bolder, lighter or a number from 1 to 1000");
const FONT_FAMILY = kept("a font family: the template's typeface, labelled by the apply result's authorFields.inPiece");
const REWRITTEN = notCopied("a scaffold key: rewritten to the id libi mints for it");

/** Every string a valid scaffold can hold (paths as `walkScaffoldSchema` reports them), and what reaches the piece. */
export const AUTHOR_TEXT_FIELDS: Readonly<Record<string, { treatment: AuthorTextTreatment; note: string }>> = {
  name: notCopied("the listing name: a new piece is named \"From template\" (NEUTRAL_PIECE_NAME)"),
  description: notCopied("listing metadata; shown only under the labelled `author` block"),
  "tags.*": notCopied("listing metadata; shown only under the labelled `author` block"),
  "canvas.aspectRatioId": notCopied("the apply copies the canvas's width, height and fps only"),

  "slots.*.key": neutralised("an unfilled slot's layer is named \"Slot <n> (fill me)\" and its placeholder file id is unfilled-slot-<n>"),
  "slots.*.label": notCopied("the placeholder uses \"Slot <n>\"; the label is only in the apply result's labelled unfilledSlots"),
  "slots.*.hint": notCopied("only in the apply result's labelled unfilledSlots"),

  "overlays.*.key": notCopied("layer ids are minted afresh; the key is only in the apply result's overlays map"),
  "overlays.*.codeFile": notCopied("the path is the template's own; the body is written under the new layer's id"),
  "overlays.*.source.assetRef": REWRITTEN,
  "overlays.*.source.slot": REWRITTEN,
  "overlays.*.text.fixed": kept("the text the layer shows: it IS the template, labelled by authorFields.inPiece"),
  "overlays.*.text.slot": notCopied("replaced by the slot's value, or by the \"Slot <n> (fill me)\" placeholder"),
  "overlays.*.fontFileId": REWRITTEN,
  "overlays.*.displayName": neutralised("dropped: the layer takes libi's default name"),
  "overlays.*.group": neutralised("a lane group libi names (captions, stickers, graphics, tracked) is kept; any other becomes template-group-<n>, so the grouping survives and the name does not"),
  "overlays.*.keyframes.rect.keyframes.*.easing": EASING,
  "overlays.*.keyframes.opacity.keyframes.*.easing": EASING,
  "overlays.*.keyframes.transform3d.keyframes.*.easing": EASING,
  "overlays.*.effects.in.effectId": EFFECT_ID,
  "overlays.*.effects.in.params.<key>": EFFECT_PARAM_KEY,
  "overlays.*.effects.in.params.<entry>": EFFECT_PARAM_VALUE,
  "overlays.*.effects.out.effectId": EFFECT_ID,
  "overlays.*.effects.out.params.<key>": EFFECT_PARAM_KEY,
  "overlays.*.effects.out.params.<entry>": EFFECT_PARAM_VALUE,
  "overlays.*.effects.loop.effectId": EFFECT_ID,
  "overlays.*.effects.loop.params.<key>": EFFECT_PARAM_KEY,
  "overlays.*.effects.loop.params.<entry>": EFFECT_PARAM_VALUE,
  "overlays.*.font": kept("the CSS font shorthand: size, weight and the font family (replaced by libi's own family when the font file arrives)"),
  "overlays.*.color": neutralised("kept only when it is a CSS colour; otherwise white"),
  "overlays.*.fontFamily": FONT_FAMILY,
  "overlays.*.fontWeight": FONT_WEIGHT,
  "overlays.*.background.color": neutralised("kept only when it is a CSS colour; otherwise the background is dropped"),
  "overlays.*.stroke.color": neutralised("kept only when it is a CSS colour; otherwise the stroke is dropped"),
  "overlays.*.shadow.color": neutralised("kept only when it is a CSS colour; otherwise the shadow is dropped"),
  "overlays.*.reveal.mode": REVEAL_MODE,
  "overlays.*.reveal.highlightColor": COLOUR,
  "overlays.*.highlightColor": COLOUR,
  "overlays.*.threeD.frontColor": COLOUR,
  "overlays.*.threeD.sideColor": COLOUR,
  "overlays.*.threeD.lighting": neutralised("kept only when it is a lighting preset libi renders; otherwise dropped"),
  "overlays.*.threeD.tilt": neutralised("kept only when it is a tilt preset libi renders; otherwise dropped"),

  "audioClips.*.key": notCopied("clip ids are minted afresh; the key is only in the apply result's clips map"),
  "audioClips.*.linkedOverlayId": REWRITTEN,
  "audioClips.*.label": neutralised("dropped: the clip takes libi's default name"),
  "audioClips.*.duck.sidechainClipIds.*": REWRITTEN,
  "audioClips.*.effects.in.effectId": EFFECT_ID,
  "audioClips.*.effects.in.params.<key>": EFFECT_PARAM_KEY,
  "audioClips.*.effects.in.params.<entry>": EFFECT_PARAM_VALUE,
  "audioClips.*.effects.out.effectId": EFFECT_ID,
  "audioClips.*.effects.out.params.<key>": EFFECT_PARAM_KEY,
  "audioClips.*.effects.out.params.<entry>": EFFECT_PARAM_VALUE,
  "audioClips.*.effects.loop.effectId": EFFECT_ID,
  "audioClips.*.effects.loop.params.<key>": EFFECT_PARAM_KEY,
  "audioClips.*.effects.loop.params.<entry>": EFFECT_PARAM_VALUE,
  "audioClips.*.source.assetRef": REWRITTEN,
  "audioClips.*.source.slot": REWRITTEN,

  "assets.*.ref": notCopied("a scaffold key; the file it names gets a file id"),
  "assets.*.file": neutralised("the file is stored as template-asset-<n><ext>"),
  "assets.*.url": neutralised("downloaded and stored as template-asset-<n><ext>; the url itself is not stored in the piece"),
  "assets.*.sha256": notCopied("checked by the install, not stored"),
  "assets.*.contentType": notCopied("ignored: the stored type comes from the media allowlist"),
  "fonts.*.family": notCopied("named only in the apply result's labelled warnings; the layer's family is in its `font`"),
  "fonts.*.assetRef": REWRITTEN,

  "captionStyles.*.id": neutralised("registered as template-<id8>-style-<n>, named \"Template style <n>\""),
  "captionStyles.*.fields.color": COLOUR,
  "captionStyles.*.fields.highlightColor": COLOUR,
  "captionStyles.*.fields.fontFamily": FONT_FAMILY,
  "captionStyles.*.fields.fontWeight": FONT_WEIGHT,
  "captionStyles.*.fields.stroke.color": neutralised("kept only when it is a CSS colour; otherwise the stroke is dropped"),
  "captionStyles.*.fields.shadow.color": neutralised("kept only when it is a CSS colour; otherwise the shadow is dropped"),
  "captionStyles.*.fields.background.color": neutralised("kept only when it is a CSS colour; otherwise the background is dropped"),
  "captionStyles.*.fields.reveal.mode": REVEAL_MODE,
  "captionStyles.*.fields.reveal.highlightColor": COLOUR,
};

/** The only author text a stranger's template leaves in the user's piece: what its layers show, and font families. */
export const KEPT_AUTHOR_TEXT: readonly string[] = [
  "overlays.*.text.fixed",
  "overlays.*.font",
  "overlays.*.fontFamily",
  "captionStyles.*.fields.fontFamily",
];

// ---------------------------------------------------------------------------
// Closed sets
// ---------------------------------------------------------------------------

/** The CSS named colours (CSS Color Module Level 4), plus `transparent` and `currentcolor`. */
const CSS_COLOUR_NAMES: ReadonlySet<string> = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
    "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
    "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue " +
    "mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen transparent currentcolor"
  ).split(" "),
);
const HEX_COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** A colour function whose arguments are numbers, units and separators — no words. */
const FUNCTION_COLOUR = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[-+0-9.,%/\s]|deg|turn|rad|none)*\)$/i;
/** The predefined spaces `color()` takes (CSS Color 4). */
const COLOR_SPACES = "srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65";
/** `color(<space> c1 c2 c3 [/ alpha])`: a closed space name, then numbers only. */
const COLOR_FUNCTION = new RegExp(`^color\\(\\s*(?:${COLOR_SPACES})(?:\\s+(?:[-+]?[0-9.]+%?|none)){3}\\s*(?:/\\s*(?:[-+]?[0-9.]+%?|none)\\s*)?\\)$`, "i");
/** `color-mix(in <space> [<hue method> hue], …`: the interpolation part, a closed set of words. */
const MIX_METHOD = new RegExp(`^in\\s+(?:${COLOR_SPACES}|lab|oklab|hsl|hwb|lch|oklch)(?:\\s+(?:shorter|longer|increasing|decreasing)\\s+hue)?$`, "i");
const MIX_PERCENT = /^[0-9.]+%$/;

/** Split on commas outside parentheses. */
function topLevelArgs(inner: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return null;
    else if (c === "," && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  out.push(inner.slice(start).trim());
  return out;
}

/** One `color-mix()` component: a colour, optionally with a percentage on either side. */
function isMixComponent(part: string, depth: number): boolean {
  const pct = part.match(/^([0-9.]+%)\s+([\s\S]+)$/) ?? part.match(/^([\s\S]+?)\s+([0-9.]+%)$/);
  if (pct) {
    const [a, b] = [pct[1], pct[2]];
    return MIX_PERCENT.test(a) ? isColour(b.trim(), depth) : isColour(a.trim(), depth) && MIX_PERCENT.test(b);
  }
  return isColour(part, depth);
}

/** `color-mix(in <space>, <colour> [%], <colour> [%])`, its colours checked the same way (nesting bounded). */
function isColorMix(v: string, depth: number): boolean {
  const m = /^color-mix\(([\s\S]*)\)$/i.exec(v);
  if (!m || depth > 3) return false;
  const args = topLevelArgs(m[1]);
  if (!args || args.length !== 3 || !MIX_METHOD.test(args[0])) return false;
  return isMixComponent(args[1], depth + 1) && isMixComponent(args[2], depth + 1);
}

function isColour(raw: string, depth: number): boolean {
  const v = raw.trim();
  return (
    HEX_COLOUR.test(v) ||
    FUNCTION_COLOUR.test(v) ||
    COLOR_FUNCTION.test(v) ||
    CSS_COLOUR_NAMES.has(v.toLowerCase()) ||
    isColorMix(v, depth)
  );
}

export function isCssColour(v: unknown): v is string {
  return typeof v === "string" && isColour(v, 0);
}

/** A CSS font weight: a keyword, or a number from 1 to 1000. */
export function isFontWeight(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v) && v >= 1 && v <= 1000;
  if (typeof v !== "string") return false;
  if (/^(?:normal|bold|bolder|lighter)$/.test(v)) return true;
  if (!/^\d+(?:\.\d+)?$/.test(v)) return false;
  const n = Number(v);
  return n >= 1 && n <= 1000;
}

const REVEAL_MODES: readonly CaptionRevealMode[] = ["none", "typewriter", "fade-words", "slide-up", "pop", "karaoke", "word-current", "flythrough"];
const LIGHTINGS: ReadonlyArray<NonNullable<TextThreeD["lighting"]>> = ["studio", "soft", "dramatic", "flat"];
const TILTS: ReadonlyArray<NonNullable<TextThreeD["tilt"]>> = ["billboard", "ground", "lowAngle", "highAngle", "angled"];
const EASING_IDS: ReadonlySet<string> = new Set(EASING_PRESETS.map((p) => p.id));
const NUMERIC_BEZIER = /^cubic-bezier\(\s*-?\d*\.?\d+\s*(?:,\s*-?\d*\.?\d+\s*){3}\)$/i;
/** The lane groups libi itself names (lib/overlays/lanes.ts): no author text in them. */
const LANE_GROUPS: ReadonlySet<string> = new Set((["text", "image", "video", "code", "three", "tracked"] as const).map(defaultGroupForKind));

// ---------------------------------------------------------------------------
// The neutralisers
// ---------------------------------------------------------------------------

/** Where in the template a value was left out: a position, never a key or a name the author chose. */
export interface TemplatePlace {
  kind: "layer" | "audio clip" | "caption style";
  /** 1-based position in the scaffold's overlays, audioClips or captionStyles. */
  n: number;
  /** The id libi minted for the layer or clip in the user's piece — libi's
   *  text, and what lets the agent point at the layer the user sees (the
   *  timeline orders by z, not by template position). */
  id?: string;
}

/** Per apply: the neutral group names handed out, and what was left out, where. */
export interface NeutraliseContext {
  groups: Map<string, string>;
  leftOut: Array<{ at: TemplatePlace; what: string }>;
  /** Whether the custom effects on disk were loaded into the registry for this apply. */
  customEffectsLoaded: boolean;
}

export function newNeutraliseContext(): NeutraliseContext {
  return { groups: new Map(), leftOut: [], customEffectsLoaded: false };
}

const PLACE_ORDER: Record<TemplatePlace["kind"], number> = { layer: 0, "audio clip": 1, "caption style": 2 };

/**
 * What the apply left out of a stranger's template, one line per place and
 * kind, in template order: "layer 3 (text-ab12cd34): exit effect not
 * available". libi's words only — a position, the id libi minted and a fixed
 * label, never the author's value — so the agent can repeat it to the user as
 * it stands.
 */
export function leftOutList(ctx: NeutraliseContext): string[] {
  const sorted = [...ctx.leftOut].sort((a, b) => PLACE_ORDER[a.at.kind] - PLACE_ORDER[b.at.kind] || a.at.n - b.at.n);
  return [...new Set(sorted.map(({ at, what }) => `${at.kind} ${at.n}${at.id ? ` (${at.id})` : ""}: ${what}`))];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the user is told a dropped look field was. */
const LOOK_LABEL: Record<string, string> = {
  color: "colour not recognised",
  highlightColor: "highlight colour not recognised",
  fontWeight: "font weight not recognised",
  stroke: "outline not recognised",
  shadow: "shadow not recognised",
  background: "background not recognised",
  reveal: "text reveal not available",
  frontColor: "3D colour not recognised",
  sideColor: "3D colour not recognised",
  lighting: "3D lighting not available",
  tilt: "3D tilt not available",
};
const PHASE_LABEL: Record<string, string> = { in: "entrance", out: "exit", loop: "loop" };
const EASING_LABEL = "animation easing not recognised (plays linear)";

function leaveOut(ctx: NeutraliseContext, at: TemplatePlace, what: string): void {
  ctx.leftOut.push({ at, what });
}

function dropKey(o: Obj, key: string, ctx: NeutraliseContext, at: TemplatePlace, what: string): void {
  if (key in o) {
    delete o[key];
    leaveOut(ctx, at, what);
  }
}

/** A nested look object (`stroke`, `shadow`, `background`) whose colour is not a colour goes whole. */
function checkColouredObject(o: Obj, key: string, ctx: NeutraliseContext, at: TemplatePlace): void {
  const v = o[key];
  if (v === undefined || v === null) return;
  if (!isObj(v) || !isCssColour(v.color)) dropKey(o, key, ctx, at, LOOK_LABEL[key]);
  else o[key] = { ...v };
}

/**
 * The LOOK fields a text overlay and a caption style share, narrowed in place
 * to values the renderer understands. The font family stays (it is the
 * template's typeface); every other string is a colour, a weight keyword or a
 * preset name, or it goes — and is listed as left out, at `at`.
 */
export function neutraliseLook(o: Obj, ctx: NeutraliseContext, at: TemplatePlace): void {
  if (o.color !== undefined && !isCssColour(o.color)) dropKey(o, "color", ctx, at, LOOK_LABEL.color);
  if (o.highlightColor !== undefined && !isCssColour(o.highlightColor)) dropKey(o, "highlightColor", ctx, at, LOOK_LABEL.highlightColor);
  if (typeof o.fontWeight === "string" && !isFontWeight(o.fontWeight)) dropKey(o, "fontWeight", ctx, at, LOOK_LABEL.fontWeight);
  for (const key of ["stroke", "shadow", "background"]) checkColouredObject(o, key, ctx, at);
  if (isObj(o.reveal)) {
    if (!REVEAL_MODES.includes(o.reveal.mode as CaptionRevealMode)) dropKey(o, "reveal", ctx, at, LOOK_LABEL.reveal);
    else {
      const reveal = { ...o.reveal };
      if (reveal.highlightColor !== undefined && !isCssColour(reveal.highlightColor)) {
        dropKey(reveal, "highlightColor", ctx, at, "reveal highlight colour not recognised");
      }
      o.reveal = reveal;
    }
  }
  if (isObj(o.threeD)) {
    const threeD = { ...o.threeD };
    for (const key of ["frontColor", "sideColor"]) if (threeD[key] !== undefined && !isCssColour(threeD[key])) dropKey(threeD, key, ctx, at, LOOK_LABEL[key]);
    if (threeD.lighting !== undefined && !LIGHTINGS.includes(threeD.lighting as never)) dropKey(threeD, "lighting", ctx, at, LOOK_LABEL.lighting);
    if (threeD.tilt !== undefined && !TILTS.includes(threeD.tilt as never)) dropKey(threeD, "tilt", ctx, at, LOOK_LABEL.tilt);
    o.threeD = threeD;
  }
}

/**
 * The effect `effectId` names, if libi has it. A custom effect the user
 * installed lives on disk and reaches this process's registry only when
 * something loads it — in the MCP child, only the effect tools did — so on a
 * miss the packages are loaded once per apply and the lookup tried again.
 */
function effectFor(effectId: string, ctx: NeutraliseContext) {
  const found = findEffect(effectId);
  if (found || ctx.customEffectsLoaded) return found;
  ctx.customEffectsLoaded = true;
  try {
    refreshCustomEffects();
  } catch {
    // A disk error leaves the built-ins; the effect is listed as left out.
  }
  return findEffect(effectId);
}

/** Each effect narrowed to one libi has, and its params to the ones that effect declares, with values it accepts. */
function neutraliseEffects(o: Obj, ctx: NeutraliseContext, at: TemplatePlace): void {
  if (!isObj(o.effects)) return;
  const effects: Obj = {};
  for (const [phase, ref] of Object.entries(o.effects)) {
    if (!isObj(ref)) continue;
    const label = PHASE_LABEL[phase] ?? "an";
    const def = typeof ref.effectId === "string" ? effectFor(ref.effectId, ctx) : undefined;
    if (!def) {
      leaveOut(ctx, at, `${label} effect not available`);
      continue;
    }
    const out: Obj = { ...ref };
    if (isObj(ref.params)) {
      const params: Obj = {};
      for (const [k, v] of Object.entries(ref.params)) {
        const p = def.meta.params.find((d) => d.key === k);
        const ok =
          p !== undefined &&
          (p.type === "number" ? typeof v === "number" : p.type === "enum" ? typeof v === "string" && (p.options ?? []).includes(v) : isCssColour(v));
        if (ok) params[k] = v;
        else leaveOut(ctx, at, `${label} effect setting not recognised`);
      }
      out.params = params;
    }
    effects[phase] = out;
  }
  if (Object.keys(effects).length > 0) o.effects = effects;
  else delete o.effects;
}

/** Every keyframe's easing narrowed to a preset id or a numeric cubic-bezier(). */
function neutraliseKeyframes(o: Obj, ctx: NeutraliseContext, at: TemplatePlace): void {
  if (!isObj(o.keyframes)) return;
  const tracks: Obj = {};
  for (const [track, value] of Object.entries(o.keyframes)) {
    if (!isObj(value) || !Array.isArray(value.keyframes)) {
      tracks[track] = value;
      continue;
    }
    tracks[track] = {
      ...value,
      keyframes: value.keyframes.map((k: unknown) => {
        if (!isObj(k) || k.easing === undefined) return k;
        const easing = String(k.easing);
        if (EASING_IDS.has(easing) || NUMERIC_BEZIER.test(easing.trim())) return k;
        const rest = { ...k };
        dropKey(rest, "easing", ctx, at, EASING_LABEL);
        return rest;
      }),
    };
  }
  o.keyframes = tracks;
}

/** A lane group libi names stays; any other is renamed template-group-<n>, one name per distinct group. */
function neutralGroup(group: string, ctx: NeutraliseContext): string {
  if (LANE_GROUPS.has(group)) return group;
  let name = ctx.groups.get(group);
  if (!name) {
    name = `template-group-${ctx.groups.size + 1}`;
    ctx.groups.set(group, name);
  }
  return name;
}

/** A stranger's overlay, in place, as it may land in the user's piece (see AUTHOR_TEXT_FIELDS). `layer` is its 1-based position in the template; `o.id` is the id libi minted for it. */
export function neutraliseOverlay(o: Obj, ctx: NeutraliseContext, layer: number): void {
  const at: TemplatePlace = { kind: "layer", n: layer, ...mintedId(o) };
  delete o.displayName;
  if (typeof o.group === "string") o.group = neutralGroup(o.group, ctx);
  neutraliseLook(o, ctx, at);
  // A text layer cannot go without a colour: one that was not a colour draws white.
  if (o.kind === "text" && typeof o.color !== "string") o.color = "#ffffff";
  neutraliseEffects(o, ctx, at);
  neutraliseKeyframes(o, ctx, at);
}

/** A stranger's audio clip, in place, as it may land in the user's piece. `clip` is its 1-based position in the template; `c.id` is the id libi minted for it. */
export function neutraliseClip(c: Obj, ctx: NeutraliseContext, clip: number): void {
  delete c.label;
  neutraliseEffects(c, ctx, { kind: "audio clip", n: clip, ...mintedId(c) });
}

/** The id libi minted, when the caller set one — never anything else a template carries. */
function mintedId(o: Obj): { id?: string } {
  return typeof o.id === "string" && /^[a-z0-9]+[-_][a-z0-9]+$/.test(o.id) ? { id: o.id } : {};
}

/** The placeholder a stranger's unfilled slot shows: its position, never its key or label. */
export function neutralSlotName(n: number): string {
  return `Slot ${n}`;
}

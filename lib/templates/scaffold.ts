/**
 * `template.json` (schema version 1) as the APP reads it.
 *
 * The contract itself — the zod schema, its limits and the allowlists it
 * applies — lives in `lib/templates/scaffold-schema.ts`, a dependency-free file
 * libi-site copies byte-for-byte to validate what strangers publish. This
 * module re-exports it and adds what only the app needs: overlay and clip types
 * narrowed per kind off the piece model (`PersistedOverlay`), and the helpers
 * built on them. Client-safe: no fs, no db, no node globals.
 */
import { z } from "zod/v3";
import type { PersistedOverlay, PersistedAudioClip } from "@/lib/composition/persistence";
import {
  templateScaffoldSchema,
  TEMPLATE_LIMITS,
  TEMPLATE_TAG_RE,
  type TemplateAsset,
  type TemplateMusicLink,
  type TemplateSlot,
  type TemplateSource,
  type TemplateText,
} from "@/lib/templates/scaffold-schema";

export {
  templateScaffoldSchema,
  TEMPLATE_SCHEMA_VERSION,
  TEMPLATE_KEY_RE,
  TEMPLATE_TAG_RE,
  TEMPLATE_LIMITS,
  type TemplateAsset,
  type TemplateMusicLink,
  type TemplateSlot,
  type TemplateSource,
  type TemplateText,
} from "@/lib/templates/scaffold-schema";

/** Piece-scoped ids a scaffold may never carry (spec §3.5), dropped from each
 *  member of the overlay union — distributive, so a kind's own fields (a text
 *  overlay's `font`/`color`, a video's `trim`) survive.
 *
 *  `caption` goes too: a caption-group ref is footage-specific (and carries the
 *  piece-scoped `groupId`), exactly as `lib/overlays/presets.ts` excludes it
 *  from a reusable preset. The reusable half travels as `captionStyles[]`, which
 *  extract inlines from the presets a `caption.styleRef` named. */
type WithoutOverlayIds<T> = T extends unknown
  ? Omit<T, "id" | "fileId" | "trackId" | "content" | "trackContent" | "drawFunction" | "sceneFunction" | "caption">
  : never;

export type TemplateOverlay = WithoutOverlayIds<
  Extract<PersistedOverlay, { kind: "text" | "image" | "video" | "code" | "three" }>
> & {
  key: string;
  codeFile?: string;
  source?: TemplateSource;
  text?: TemplateText;
};

export type TemplateAudioClip = Omit<PersistedAudioClip, "id" | "fileId" | "duck"> & {
  key: string;
  source: TemplateSource;
  /** Duck params as a piece stores them, minus the deprecated singular
   *  `sidechainClipId` — that one holds a clip ID, while `sidechainClipIds`
   *  hold clip KEYS. `duckSchema` rejects it at parse time. */
  duck?: Omit<NonNullable<PersistedAudioClip["duck"]>, "sidechainClipId">;
};

/** A valid scaffold, with overlays and clips typed per kind off the piece model.
 *  `validateScaffold` is the one way to get one from untrusted JSON. */
export interface TemplateScaffold {
  schema: 1;
  name: string;
  description: string;
  tags: string[];
  canvas: { width: number; height: number; fps: number; aspectRatioId?: string };
  duration: number;
  slots: TemplateSlot[];
  overlays: TemplateOverlay[];
  audioClips: TemplateAudioClip[];
  assets: TemplateAsset[];
  musicLinks?: TemplateMusicLink[];
  fonts: Array<{ family: string; assetRef: string }>;
  captionStyles: Array<{ id: string; fields: Record<string, unknown> }>;
}

export function codeFileFor(kind: "code" | "three", key: string): string {
  return `overlays/${key}/${kind === "code" ? "draw" : "scene"}.jsx`;
}

export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Null when `tags` (already normalized) are acceptable, else the reason. */
export function tagsError(tags: readonly string[]): string | null {
  if (tags.length > TEMPLATE_LIMITS.tags) return `tags: at most ${TEMPLATE_LIMITS.tags} tags`;
  const bad = tags.find((t) => !TEMPLATE_TAG_RE.test(t));
  return bad === undefined ? null : `tags: "${bad}" must match ${TEMPLATE_TAG_RE}`;
}

export type ScaffoldValidation = { ok: true; scaffold: TemplateScaffold } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Keyframe tracks
//
// The pinned schema (scaffold-schema.ts, shared byte for byte with libi-site)
// admits each `keyframes.<track>` as anything. The renderer lerps these
// values (lib/engine/animatable.ts), so the app holds every track to its own
// shape on every read: a stranger's template cannot hand it a string where a
// rect goes, a NaN, or a million keyframes. Unknown fields are stripped.
// ---------------------------------------------------------------------------

/** The most keyframes one track may carry. */
export const MAX_KEYFRAMES_PER_TRACK = 500;

const finite = z.number().finite();
const vec3 = z.object({ x: finite, y: finite, z: finite });
const trackOf = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    keyframes: z
      .array(z.object({ t: finite.min(0).max(1), value, easing: z.string().max(100).optional() }))
      .max(MAX_KEYFRAMES_PER_TRACK),
  });
const KEYFRAME_TRACKS = {
  rect: trackOf(z.object({ x: finite, y: finite, width: finite, height: finite })),
  opacity: trackOf(finite.min(0).max(1)),
  transform3d: trackOf(z.object({ position: vec3, rotation: vec3 })),
} as const;

// ---------------------------------------------------------------------------
// The schema, walked
//
// What a valid scaffold can hold, read off the schema itself rather than
// listed by hand, so a field added to it later is seen: the author-text audit
// (lib/templates/author-text.ts) classifies every string this finds, and a
// refusal's location keeps only the names the schema declares.
// ---------------------------------------------------------------------------

/** The paths the pinned schema types `unknown` and this module parses itself (see checkKeyframeTracks). */
const REPARSED_PATHS: Record<string, z.ZodTypeAny> = Object.fromEntries(
  Object.entries(KEYFRAME_TRACKS).map(([track, schema]) => [`overlays.*.keyframes.${track}`, schema]),
);

export interface ScaffoldSchemaWalk {
  /** Every place a valid scaffold holds a string, as a path pattern: `*` is an
   *  array index, `<key>` a record's key, `<entry>` a record's value. */
  strings: string[];
  /** Every field name the schema declares: the path segments libi chose, not an author. */
  names: ReadonlySet<string>;
  /** Paths typed `unknown` that nothing parses again: a string there would go unaudited. */
  opaque: string[];
}

/**
 * A field the schema declares only to refuse (scaffold-schema.ts `forbidden`):
 * it accepts nothing but absence, so it holds no value in a valid scaffold.
 * Read off the field's own behaviour, not a list of names — a list copied here
 * would keep skipping a name after the schema made it a real field again.
 * (scaffold-schema.ts is byte-pinned for libi-site, so it cannot export a marker.)
 */
function refusesEveryValue(schema: z.ZodTypeAny): boolean {
  const def = schema._def as { typeName: string; schema?: z.ZodTypeAny };
  // `unknown` admits anything, so an `unknown` whose refinement turns away
  // every present value admits only absence.
  if (def.typeName !== "ZodEffects" || def.schema?._def.typeName !== "ZodUnknown") return false;
  if (!schema.safeParse(undefined).success) return false;
  // Every probe refused, and refused in the schema's own words for a key that
  // may never appear (scaffold-schema.ts `forbidden`): an `unknown` that
  // admits absence plus some SHAPED value turns these probes away too, and
  // must be audited, not skipped.
  return REFUSAL_PROBES.every((v) => {
    const r = schema.safeParse(v);
    return !r.success && r.error.issues.length > 0 && r.error.issues.every((i) => i.message.endsWith(FORBIDDEN_KEY_MESSAGE));
  });
}

/** The words scaffold-schema.ts's `forbidden(k)` refuses with: "<k> may not appear in a scaffold". */
const FORBIDDEN_KEY_MESSAGE = " may not appear in a scaffold";
const REFUSAL_PROBES: unknown[] = ["", "x", "https://example.com/a.png", 0, 1, true, false, null, {}, { a: "x" }, [], ["x"]];

function walkSchema(schema: z.ZodTypeAny, path: string[], out: { strings: string[]; names: Set<string>; opaque: string[] }): void {
  const at = path.join(".");
  const def = schema._def as { typeName: string } & Record<string, unknown>;
  switch (def.typeName) {
    case "ZodObject": {
      // An object that lets undeclared keys through (`.passthrough()`, or a
      // `.catchall()` other than the default never) would admit strings this
      // walk cannot see: report it. `strip` and `strict` admit only the shape.
      if (def.unknownKeys === "passthrough") out.opaque.push(`${at || "<root>"} (passthrough)`);
      if ((def.catchall as z.ZodTypeAny | undefined)?._def.typeName !== "ZodNever") out.opaque.push(`${at || "<root>"} (catchall)`);
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      for (const [name, child] of Object.entries(shape)) {
        out.names.add(name);
        // A key the schema declares only to refuse holds nothing in a valid scaffold.
        if (!refusesEveryValue(child)) walkSchema(child, [...path, name], out);
      }
      return;
    }
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return walkSchema(def.innerType as z.ZodTypeAny, path, out);
    case "ZodEffects":
      return walkSchema(def.schema as z.ZodTypeAny, path, out);
    case "ZodArray":
      return walkSchema(def.type as z.ZodTypeAny, [...path, "*"], out);
    case "ZodUnion":
      for (const option of def.options as z.ZodTypeAny[]) walkSchema(option, path, out);
      return;
    case "ZodRecord":
      walkSchema(def.keyType as z.ZodTypeAny, [...path, "<key>"], out);
      return walkSchema(def.valueType as z.ZodTypeAny, [...path, "<entry>"], out);
    case "ZodString":
      if (!out.strings.includes(at)) out.strings.push(at);
      return;
    case "ZodUnknown": {
      const reparsed = REPARSED_PATHS[at];
      if (reparsed) walkSchema(reparsed, path, out);
      else out.opaque.push(at);
      return;
    }
    case "ZodNumber":
    case "ZodBoolean":
    case "ZodEnum":
    case "ZodLiteral":
    case "ZodNever":
      return;
    default:
      // A schema kind this walk cannot see into: report it rather than skip it.
      out.opaque.push(`${at} (${def.typeName})`);
  }
}

/** Walk a scaffold-shaped schema (the audit test grows one to prove a new field is seen). */
export function walkZodSchema(schema: z.ZodTypeAny): ScaffoldSchemaWalk {
  const out = { strings: [] as string[], names: new Set<string>(), opaque: [] as string[] };
  walkSchema(schema, [], out);
  return out;
}

let walked: ScaffoldSchemaWalk | null = null;

/** The scaffold schema, walked once. */
export function walkScaffoldSchema(): ScaffoldSchemaWalk {
  walked ??= walkZodSchema(templateScaffoldSchema);
  return walked;
}

/**
 * A location inside a scaffold, safe to show next to a stranger's template:
 * array indices and the schema's own field names stay, and any other segment
 * — a record key the author chose, such as an effect param's name — becomes
 * `<key>` (ASCII: install reasons are printable ASCII only).
 */
export function pathWithoutTemplateKeys(path: ReadonlyArray<string | number>): string {
  const { names } = walkScaffoldSchema();
  return path.map((s) => (typeof s === "number" || names.has(s) ? String(s) : "<key>")).join(".");
}

/** Each track of each overlay, parsed against its own shape; the first failure's path and message. */
function checkKeyframeTracks(scaffold: TemplateScaffold): { ok: true } | { ok: false; reason: string } {
  for (const [i, o] of scaffold.overlays.entries()) {
    const kf = (o as { keyframes?: Record<string, unknown> }).keyframes;
    if (!kf) continue;
    for (const track of Object.keys(KEYFRAME_TRACKS) as Array<keyof typeof KEYFRAME_TRACKS>) {
      if (kf[track] === undefined) continue;
      const r = KEYFRAME_TRACKS[track].safeParse(kf[track]);
      if (!r.success) {
        const first = r.error.issues[0];
        return { ok: false, reason: `${pathWithoutTemplateKeys(["overlays", i, "keyframes", track, ...first.path])}: ${first.message}` };
      }
      kf[track] = r.data;
    }
  }
  return { ok: true };
}

/**
 * A scaffold problem that is safe to show next to a STRANGER's template: where
 * it is and what is wrong, never a value the template supplied. Zod quotes
 * what it received (an enum's `received 'x'`, an unrecognised key's name), and
 * any of that may be the author's words reaching the agent unlabelled. Quoted
 * spans become '…' and a trailing `received …` is dropped; the path and the
 * schema's own wording stay.
 */
export function reasonWithoutTemplateText(reason: string): string {
  return reason
    .replace(/[,;]?\s*received\b[\s\S]*$/i, "")
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "'…'")
    .trim();
}

/** Validate a parsed `template.json`. The reason names the first failing path. */
export function validateScaffold(raw: unknown): ScaffoldValidation {
  const r = templateScaffoldSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    // A record key (an effect param's name) is the author's word, not the schema's.
    const where = first.path.length ? pathWithoutTemplateKeys(first.path) : "scaffold";
    return { ok: false, reason: `${where}: ${first.message}` };
  }
  // The parse output is a fresh object: normalising its tracks in place never touches `raw`.
  const scaffold = r.data as unknown as TemplateScaffold;
  const tracks = checkKeyframeTracks(scaffold);
  return tracks.ok ? { ok: true, scaffold } : tracks;
}

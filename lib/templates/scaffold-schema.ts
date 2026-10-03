/**
 * `template.json` (schema version 1) — the zod v3 contract every reader applies
 * (spec §3.5), and every allowlist it depends on, in ONE dependency-free file.
 *
 * libi-site holds a byte-identical copy and runs the same validation on the
 * templates strangers publish to the public catalog. So this file imports
 * `zod/v3` and nothing else — not even a type — and the tables the schema reads
 * live here rather than being imported:
 *  - the media-type table (`MEDIA_TYPES_BY_KIND`, `mediaTypeFor`), re-exported
 *    by `lib/http/media-types.ts`, which owns the serving rules around it;
 *  - the preset slug rule (`isValidPresetSlug`), re-exported by
 *    `lib/overlays/presets.ts`;
 *  - the overlay / clip / caption-style field allowlists, re-exported by
 *    `lib/templates/fields.ts`.
 * Change any of them here and the pin at the bottom changes with it.
 *
 * Client-safe: no fs, no db, no node globals.
 *
 * Conventions a scaffold uses for fields that carry ids in a piece:
 *  - a text overlay's `fontFileId` is the FONT ASSET's `ref` (see `fonts`);
 *  - an audio clip's `linkedOverlayId` is the linked VIDEO OVERLAY's `key`;
 *  - `duck.sidechainClipIds` are CLIP KEYS.
 * `applyScaffold` (lib/templates/materialize.ts) rewrites all three to fresh ids.
 */
import { z } from "zod/v3";

// ---------------------------------------------------------------------------
// Media types (lib/http/media-types.ts re-exports these)
// ---------------------------------------------------------------------------

export type MediaKind = "image" | "video" | "audio" | "font";

/** extension (lower case, with the dot) → content type, per asset kind. The
 *  canonical type is what libi stores and serves; lib/http/media-types.ts adds
 *  the aliases that only widen what an already-stored row may be served inline
 *  as. A template asset's type is DERIVED from this table — never taken from
 *  the template's own free text. */
export const MEDIA_TYPES_BY_KIND: Readonly<Record<MediaKind, Readonly<Record<string, string>>>> = {
  image: {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    // A document that can carry script when navigated to. Allowed because
    // templates and uploads legitimately carry logos, but every route that
    // serves one sends `MEDIA_RESPONSE_CSP` (proxy.ts sets it by path).
    ".svg": "image/svg+xml",
  },
  video: {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
  },
  audio: {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
    // An audio clip may play a VIDEO file's audio track: detaching a video's
    // audio, or duplicating that clip, keeps the clip on the video file. Stored
    // under the video type, which is as safe to serve as any video.
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
  },
  font: {
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  },
};

/** `.PNG` → `.png`; "" when the name has no extension (or is only one). */
export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** The type libi stores for a file of this kind with this name, or null when
 *  the extension is not an allowed one for the kind. */
export function mediaTypeFor(kind: MediaKind, filename: string): string | null {
  return MEDIA_TYPES_BY_KIND[kind][extensionOf(filename)] ?? null;
}

// ---------------------------------------------------------------------------
// Preset slug (lib/overlays/presets.ts re-exports this)
// ---------------------------------------------------------------------------

const PRESET_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

/** The one slug rule for an overlay preset / caption style id. */
export function isValidPresetSlug(s: string): boolean {
  return PRESET_SLUG_RE.test(s);
}

// ---------------------------------------------------------------------------
// Field allowlists (lib/templates/fields.ts re-exports these)
//
// The ALLOWLISTS a template's contents pass through (spec §3.5: unknown fields
// are stripped). Imported by scaffold validation, by materialize and by
// caption-style registration, so a field added to `PersistedOverlay` later — a
// trust flag, an internal marker — is NOT settable by a template until someone
// lists it here on purpose.
//
// What is deliberately absent from every list:
//  - piece-scoped ids and code (`id`, `fileId`, `trackId`, `content`,
//    `trackContent`, `drawFunction`, `sceneFunction`, `caption`) — the scaffold
//    schema rejects these outright;
//  - runtime / bookkeeping markers (`unfilledSlot`, `missing`, `videoUrl`,
//    `sourceWidth`, `sourceHeight`, `version`) — set by libi itself, never by a
//    template: a template-supplied `unfilledSlot` or `missing` makes the preview
//    draw a placeholder while export renders the real video, and `version`
//    defeats the edit store's reconciliation.
// ---------------------------------------------------------------------------

/** Keys every overlay kind may carry in a scaffold. `key`/`kind` are the
 *  scaffold's own; the rest mirror `PersistedOverlay`. */
const COMMON_OVERLAY_KEYS = [
  "key",
  "kind",
  "startTime",
  "duration",
  "rect",
  "z",
  "opacity",
  "flipH",
  "flipV",
  "hidden",
  "group",
  "displayName",
  "anchor",
  "transform3d",
  // The "Make it 3D" gate. A text overlay renders through its 3D instance on
  // `place3d` alone, and the next save flattens one without it.
  "place3d",
  "keyframes",
  "effects",
] as const;

export const OVERLAY_KEYS_BY_KIND: Readonly<Record<"text" | "image" | "video" | "code" | "three", readonly string[]>> = {
  text: [
    ...COMMON_OVERLAY_KEYS,
    "text",
    "font",
    "fontFileId",
    "color",
    "align",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "background",
    "stroke",
    "shadow",
    "reveal",
    "highlightColor",
    "threeD",
    "position",
    "maxWidthPct",
  ],
  image: [...COMMON_OVERLAY_KEYS, "source"],
  video: [...COMMON_OVERLAY_KEYS, "source", "trim", "fit"],
  code: [...COMMON_OVERLAY_KEYS, "codeFile"],
  three: [...COMMON_OVERLAY_KEYS, "codeFile", "cameraPreset", "scale"],
};

/** Keys a scaffold audio clip may carry (`PersistedAudioClip` + `effects`, the
 *  in/out fades a clip stores like an overlay does, + the clip's loudness shape:
 *  `gainDb`, the `volumeKeyframes` envelope and `crossfadeMs`, + the scaffold's own). */
export const CLIP_KEYS: readonly string[] = [
  "key",
  "kind",
  "source",
  "startTime",
  "duration",
  "trimStart",
  "volume",
  "enabled",
  "linkedOverlayId",
  "timelineOrder",
  "label",
  "duck",
  "effects",
  "gainDb",
  "volumeKeyframes",
  "crossfadeMs",
];

/** A shallow copy of `o` holding only `keys` (absent/undefined values dropped). */
export function pickKeys(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

const color = z.string().max(100);

/**
 * A caption style's fields: the static LOOK keys `CaptionStyle` has
 * (`lib/captions/types.ts`), exactly the ones `styles.server.ts` reads back out
 * of a preset — and nothing that says WHICH layer or WHAT it runs. Unknown keys
 * are stripped, at every depth. A preset carrying `kind`, `id` or a code key
 * would otherwise reach `applyOverlayPreset`, whose merge can overwrite them.
 */
export const captionStyleFieldsSchema = z
  .object({
    color: color.optional(),
    highlightColor: color.optional(),
    fontFamily: z.string().max(120).optional(),
    fontWeight: z.union([z.number(), z.string().max(20)]).optional(),
    stroke: z.object({ color, width: z.number() }).nullable().optional(),
    shadow: z
      .object({ color, blur: z.number(), dx: z.number().optional(), dy: z.number().optional() })
      .nullable()
      .optional(),
    background: z
      .object({ color, padding: z.number().optional(), radius: z.number().optional() })
      .nullable()
      .optional(),
    reveal: z
      .object({
        mode: z.string().max(40),
        fraction: z.number().optional(),
        durationMs: z.number().optional(),
        highlightColor: color.optional(),
        direction: z.enum(["ltr", "rtl", "through"]).optional(),
        sideOffset: z.number().optional(),
      })
      .nullable()
      .optional(),
  })
  .strip();

export type CaptionStyleFields = z.infer<typeof captionStyleFieldsSchema>;

/** The allowlisted caption-style fields, or null when a listed field has the
 *  wrong shape. */
export function captionStyleFields(raw: unknown): CaptionStyleFields | null {
  const r = captionStyleFieldsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------
// The scaffold
// ---------------------------------------------------------------------------

export const TEMPLATE_SCHEMA_VERSION = 1 as const;
export const TEMPLATE_KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const TEMPLATE_TAG_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;

export const TEMPLATE_LIMITS = {
  nameChars: 80,
  descriptionChars: 500,
  tags: 10,
  overlays: 60,
  clips: 20,
  assets: 30,
  slots: 12,
  scaffoldBytes: 256 * 1024,
  codeFileBytes: 128 * 1024,
  instructionsBytes: 32 * 1024,
  urlBytes: 2 * 1024,
  /** One copied file (an asset, `poster.jpg`, `example.mp4`). */
  assetBytes: 1024 * 1024 * 1024,
  /** Every copied file of one template together. */
  totalBytes: 2 * 1024 * 1024 * 1024,
} as const;

export interface TemplateSlot {
  key: string;
  kind: "text" | "image" | "video" | "audio";
  label: string;
  hint?: string;
  required: boolean;
}

export type TemplateSource = { assetRef: string } | { slot: string } | { musicRef: string };
export type TemplateText = { fixed: string } | { slot: string };

/** A copyrighted song the template NAMES but never carries (social-music spec
 *  §7): applying it leaves the song out; the agent fetches it on the user's yes. */
export interface TemplateMusicLink {
  ref: string;
  track: { title: string; artist?: string };
  sourceUrl?: string;
}

export interface TemplateAsset {
  ref: string;
  kind: "image" | "video" | "audio" | "font";
  file?: string;
  url?: string;
  sha256?: string;
  bytes?: number;
  /** Advisory only, and IGNORED on apply: the stored type is derived from the
   *  file's extension and `kind` (`mediaTypeFor` above), never taken from a
   *  template's free text — `text/html` here would otherwise make the asset a
   *  page in libi's origin. */
  contentType?: string;
}

// Every key that would smuggle a piece-scoped id into a scaffold. `caption`
// holds a caption-group id (`groupId`) and is footage-specific; `trackContent`
// is the tracked overlay's payload. Checked one level down too — `duck`'s
// deprecated singular `sidechainClipId` is a real clip id (see `duckSchema`).
const FORBIDDEN_OVERLAY_KEYS = ["id", "fileId", "trackId", "content", "trackContent", "drawFunction", "sceneFunction", "caption"] as const;
const FORBIDDEN_CLIP_KEYS = ["id", "fileId"] as const;
// No leading dot: `assets/.` (the folder itself — EISDIR on apply) and dot-files
// are not assets.
const ASSET_FILE_RE = /^assets\/(?!\.)[^/\\]+$/;
const CODE_FILE_RE = /^overlays\/([a-z][a-z0-9-]{0,39})\/(draw|scene)\.jsx$/;

/** A path a template may not name: empty, absolute, windows-separated, or
 *  reaching upwards. `..` anywhere is enough — no segment of a legal scaffold
 *  path ever contains it. */
function unsafeRelPath(p: string): boolean {
  return p.length === 0 || p.startsWith("/") || p.includes("\\") || p.includes("..");
}

/** utf-8 byte length, without `Buffer` — this module is imported by the UI. */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const sourceSchema = z.union([
  z.object({ assetRef: z.string() }).strict(),
  z.object({ slot: z.string() }).strict(),
  z.object({ musicRef: z.string() }).strict(),
]);
const textSchema = z.union([z.object({ fixed: z.string().max(5000) }).strict(), z.object({ slot: z.string() }).strict()]);

const slotSchema = z.object({
  key: z.string().regex(TEMPLATE_KEY_RE, "key must match ^[a-z][a-z0-9-]{0,39}$"),
  kind: z.enum(["text", "image", "video", "audio"]),
  label: z.string().min(1).max(80),
  hint: z.string().max(300).optional(),
  required: z.boolean(),
});

const assetSchema = z
  .object({
    ref: z.string().regex(TEMPLATE_KEY_RE, "ref must match ^[a-z][a-z0-9-]{0,39}$"),
    kind: z.enum(["image", "video", "audio", "font"]),
    file: z.string().optional(),
    url: z.string().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    bytes: z.number().int().nonnegative().optional(),
    contentType: z.string().max(120).optional(),
  })
  .superRefine((a, ctx) => {
    const hasFile = a.file !== undefined;
    const hasUrl = a.url !== undefined;
    if (hasFile === hasUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one of file/url" });
    if (hasFile && (unsafeRelPath(a.file!) || !ASSET_FILE_RE.test(a.file!))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["file"], message: "file must be assets/<basename>" });
    } else if (hasFile && mediaTypeFor(a.kind, a.file!) === null) {
      // The extension decides the content type the file is stored and served
      // as, so one outside the kind's allowlist (`logo.html` as an image) is
      // refused here, before anything is copied.
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["file"], message: `file extension is not an allowed ${a.kind} type` });
    }
    if (hasUrl) {
      if (utf8Bytes(a.url!) > TEMPLATE_LIMITS.urlBytes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "url over 2 KB" });
      }
      let protocol = "";
      try {
        protocol = new URL(a.url!).protocol;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "url does not parse" });
      }
      if (protocol && protocol !== "https:") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "url must be https:" });
    }
  });

const musicLinkSchema = z
  .object({
    ref: z.string().regex(TEMPLATE_KEY_RE, "ref must match ^[a-z][a-z0-9-]{0,39}$"),
    track: z.object({ title: z.string().min(1).max(120), artist: z.string().min(1).max(120).optional() }).strict(),
    sourceUrl: z.string().optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.sourceUrl === undefined) return;
    if (utf8Bytes(m.sourceUrl) > TEMPLATE_LIMITS.urlBytes) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceUrl"], message: "sourceUrl over 2 KB" });
    let protocol = "";
    try {
      protocol = new URL(m.sourceUrl).protocol;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceUrl"], message: "sourceUrl does not parse" });
    }
    if (protocol && protocol !== "https:") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceUrl"], message: "sourceUrl must be https:" });
  });

// Typed shapes for the per-kind fields the allowlist (OVERLAY_KEYS_BY_KIND)
// admits beyond the scaffold's own. Objects strip unknown keys at every depth.
const vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });
const effectRefSchema = z.object({
  effectId: z.string().max(100),
  durationMs: z.number().optional(),
  params: z.record(z.union([z.number(), z.string().max(500)])).optional(),
});
const effectsSchema = z.object({ in: effectRefSchema.optional(), out: effectRefSchema.optional(), loop: effectRefSchema.optional() });
const look = captionStyleFieldsSchema.shape;

/** A scaffold-side key that must never appear: present at all is an error. */
const forbidden = (k: string) => z.unknown().refine((v) => v === undefined, `${k} may not appear in a scaffold`);

const overlaySchema = z
  .object({
    ...Object.fromEntries(FORBIDDEN_OVERLAY_KEYS.map((k) => [k, forbidden(k)])),
    key: z.string().regex(TEMPLATE_KEY_RE, "key must match ^[a-z][a-z0-9-]{0,39}$"),
    kind: z.enum(["text", "image", "video", "code", "three"]),
    startTime: z.number().min(0),
    duration: z.number().positive(),
    rect: rectSchema,
    z: z.number(),
    opacity: z.number().min(0).max(1),
    codeFile: z.string().optional(),
    source: sourceSchema.optional(),
    text: textSchema.optional(),
    fontFileId: z.string().optional(),
    displayName: z.string().max(120).optional(),
    // Every kind.
    flipH: z.boolean().optional(),
    flipV: z.boolean().optional(),
    hidden: z.boolean().optional(),
    group: z.string().max(120).optional(),
    anchor: z
      .enum(["top-left", "top-center", "top-right", "mid-left", "mid-center", "mid-right", "bottom-left", "bottom-center", "bottom-right"])
      .optional(),
    transform3d: z.object({ position: vec3Schema, rotation: vec3Schema }).optional(),
    place3d: z.boolean().optional(),
    keyframes: z.object({ rect: z.unknown(), opacity: z.unknown(), transform3d: z.unknown() }).partial().optional(),
    effects: effectsSchema.optional(),
    // text
    font: z.string().max(300).optional(),
    color: z.string().max(100).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    fontFamily: look.fontFamily,
    fontSize: z.number().optional(),
    fontWeight: look.fontWeight,
    lineHeight: z.number().optional(),
    background: look.background,
    stroke: look.stroke,
    shadow: look.shadow,
    reveal: look.reveal,
    highlightColor: look.highlightColor,
    threeD: z
      .object({
        depth: z.number(),
        bevel: z.number().optional(),
        frontColor: z.string().max(100).optional(),
        sideColor: z.string().max(100).optional(),
        lighting: z.string().max(40).optional(),
        tilt: z.string().max(40).optional(),
      })
      .optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    maxWidthPct: z.number().optional(),
    // video
    trim: z.object({ start: z.number(), end: z.number() }).optional(),
    fit: z.enum(["cover", "contain"]).optional(),
    // three
    cameraPreset: z.enum(["billboard", "ground", "lowAngle", "highAngle", "angled"]).optional(),
    scale: z.number().optional(),
  })
  // Spec §3.5: unknown fields are STRIPPED — including libi's own runtime
  // markers (`unfilledSlot`, `missing`, `version`, `videoUrl`), which a
  // template must never be able to set. See the field allowlists above.
  .strip()
  .superRefine((o, ctx) => {
    const wants = { text: o.kind === "text", source: o.kind === "image" || o.kind === "video", codeFile: o.kind === "code" || o.kind === "three" };
    if (wants.text !== (o.text !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: wants.text ? "text overlay needs text" : "text only on text overlays" });
    if (wants.source !== (o.source !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: wants.source ? `${o.kind} overlay needs source` : "source only on image/video overlays" });
    if (wants.codeFile !== (o.codeFile !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["codeFile"], message: wants.codeFile ? `${o.kind} overlay needs codeFile` : "codeFile only on code/three overlays" });
    if (o.codeFile !== undefined) {
      const m = unsafeRelPath(o.codeFile) ? null : CODE_FILE_RE.exec(o.codeFile);
      const expected = o.kind === "code" ? "draw" : "scene";
      if (!m || m[1] !== o.key || m[2] !== expected) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["codeFile"], message: `codeFile must be overlays/${o.key}/${expected}.jsx` });
      }
    }
    if (o.fontFileId !== undefined && o.kind !== "text") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fontFileId"], message: "fontFileId only on text overlays" });
    // The kind-specific fields `TemplateOverlay`'s text arm promises as required.
    // Unchecked, a `template.json` missing `font` validates and hands materialize
    // a value typed `string` that is `undefined` at runtime.
    if (o.kind === "text") {
      if (typeof o.font !== "string") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["font"], message: "text overlay needs font" });
      if (typeof o.color !== "string") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["color"], message: "text overlay needs color" });
      if (o.align === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["align"], message: "text overlay needs align: left, center or right" });
      }
    }
  })
  // Then keep only the fields THIS kind has: a `trim` on a text overlay or a
  // `cameraPreset` on a code one is dropped rather than persisted.
  .transform((o) => pickKeys(o, OVERLAY_KEYS_BY_KIND[o.kind]) as typeof o);

const duckSchema = z.object({
  sidechainClipIds: z.array(z.string()).max(TEMPLATE_LIMITS.clips),
  /** Pre-2026-08-18 single-sidechain spelling. It holds a real clip ID, not a
   *  clip KEY, so a scaffold may never carry it — `sanitizeDuck` has already
   *  folded it into `sidechainClipIds` by the time extract reads a clip. */
  sidechainClipId: z.never().optional(),
  thresholdDb: z.number(),
  ratio: z.number(),
  attackMs: z.number(),
  releaseMs: z.number(),
  reductionDb: z.number(),
});

const clipSchema = z
  .object({
    ...Object.fromEntries(FORBIDDEN_CLIP_KEYS.map((k) => [k, forbidden(k)])),
    key: z.string().regex(TEMPLATE_KEY_RE, "key must match ^[a-z][a-z0-9-]{0,39}$"),
    kind: z.enum(["inline", "standalone"]),
    startTime: z.number().min(0),
    duration: z.number().positive(),
    trimStart: z.number().min(0),
    volume: z.number().min(0),
    enabled: z.boolean(),
    linkedOverlayId: z.string().optional(),
    timelineOrder: z.number().optional(),
    label: z.string().max(120).optional(),
    duck: duckSchema.optional(),
    effects: effectsSchema.optional(),
    /** Static gain in dB (AudioClip.gainDb). An older reader strips it: the clip plays at plain volume. */
    gainDb: z.number().min(-60).max(12).optional(),
    /** Volume envelope (AudioClip.volumeKeyframes): `t` seconds from the clip's start, `value` a dB offset. */
    volumeKeyframes: z
      .object({
        keyframes: z
          .array(
            z.object({
              t: z.number().min(0),
              value: z.number().min(-60).max(12),
              easing: z.string().max(40).optional(),
            }),
          )
          .max(200),
      })
      .optional(),
    /** Milliseconds the clip crossfades over the earlier clip of the same file (AudioClip.crossfadeMs). */
    crossfadeMs: z.number().min(0).max(5000).optional(),
    source: sourceSchema,
  })
  .strip()
  .transform((c) => pickKeys(c, CLIP_KEYS) as typeof c);

export const templateScaffoldSchema = z
  .object({
    schema: z.literal(TEMPLATE_SCHEMA_VERSION),
    name: z.string().min(1).max(TEMPLATE_LIMITS.nameChars),
    description: z.string().max(TEMPLATE_LIMITS.descriptionChars),
    tags: z.array(z.string().regex(TEMPLATE_TAG_RE)).max(TEMPLATE_LIMITS.tags),
    canvas: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.number().positive(),
      aspectRatioId: z.string().max(20).optional(),
    }),
    duration: z.number().min(0),
    slots: z.array(slotSchema).max(TEMPLATE_LIMITS.slots),
    overlays: z.array(overlaySchema).max(TEMPLATE_LIMITS.overlays),
    audioClips: z.array(clipSchema).max(TEMPLATE_LIMITS.clips),
    assets: z.array(assetSchema).max(TEMPLATE_LIMITS.assets),
    musicLinks: z.array(musicLinkSchema).max(TEMPLATE_LIMITS.clips).optional(),
    fonts: z.array(z.object({ family: z.string().min(1).max(120), assetRef: z.string() })),
    // Caption styles are referenced by the same slug shape an overlay preset id
    // has — `isValidPresetSlug`, the one validator, never a second copy of it.
    // `fields` pass the caption-style LOOK allowlist (`captionStyleFieldsSchema`):
    // they become a user preset on apply, and a preset's fields are merged over
    // an overlay — `kind`, `id` or a code key there would rewrite the layer.
    captionStyles: z.array(z.object({ id: z.string().refine(isValidPresetSlug, "must be a preset slug"), fields: captionStyleFieldsSchema })),
  })
  .strip()
  .superRefine((s, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const dupe = (items: Array<{ key: string }>, path: string) => {
      const seen = new Set<string>();
      items.forEach((it, i) => {
        if (seen.has(it.key)) issue([path, i, "key"], `duplicate key "${it.key}"`);
        seen.add(it.key);
      });
    };
    dupe(s.slots, "slots");
    dupe(s.overlays, "overlays");
    dupe(s.audioClips, "audioClips");
    const assetRefs = new Set<string>();
    s.assets.forEach((a, i) => {
      if (assetRefs.has(a.ref)) issue(["assets", i, "ref"], `duplicate ref "${a.ref}"`);
      assetRefs.add(a.ref);
    });
    const musicRefs = new Set<string>();
    (s.musicLinks ?? []).forEach((m, i) => {
      if (assetRefs.has(m.ref) || musicRefs.has(m.ref)) issue(["musicLinks", i, "ref"], `duplicate ref "${m.ref}"`);
      musicRefs.add(m.ref);
    });
    const slots = new Map(s.slots.map((sl) => [sl.key, sl]));
    const assets = new Map(s.assets.map((a) => [a.ref, a]));
    const overlayKinds = new Map(s.overlays.map((o) => [o.key, o.kind]));
    const clipKeys = new Set(s.audioClips.map((c) => c.key));
    const fontRefs = new Set(s.fonts.map((f) => f.assetRef));

    /** `alsoAllow` is the one cross-kind asset a source may name: an INLINE
     *  clip's audio IS the linked video's audio track, so extract points the
     *  clip at the SAME `video` asset the overlay uses rather than copying the
     *  file a second time as `audio` (it is usually the biggest file in the
     *  template, and it would spend two of the 30-asset budget). A standalone
     *  clip gets no such licence — it has no video overlay to take its audio
     *  from. Only `assetRef` is widened; a slot still has to be an audio slot. */
    const checkSource = (
      src: TemplateSource,
      want: "image" | "video" | "audio",
      path: (string | number)[],
      alsoAllow?: TemplateAsset["kind"],
    ) => {
      if ("musicRef" in src) {
        if (want !== "audio") return issue(path, "a music link can only be an audio clip's source");
        if (!musicRefs.has(src.musicRef)) issue(path, `music link "${src.musicRef}" does not exist`);
        return;
      }
      if ("slot" in src) {
        const sl = slots.get(src.slot);
        if (!sl) return issue(path, `slot "${src.slot}" does not exist`);
        if (sl.kind !== want) issue(path, `slot "${src.slot}" has kind ${sl.kind}, expected ${want}`);
      } else {
        const a = assets.get(src.assetRef);
        if (!a) return issue(path, `asset "${src.assetRef}" does not exist`);
        if (a.kind !== want && a.kind !== alsoAllow) issue(path, `asset "${src.assetRef}" has kind ${a.kind}, expected ${want}`);
      }
    };

    s.overlays.forEach((o, i) => {
      if (o.text && "slot" in o.text) {
        const sl = slots.get(o.text.slot);
        if (!sl) issue(["overlays", i, "text"], `slot "${o.text.slot}" does not exist`);
        else if (sl.kind !== "text") issue(["overlays", i, "text"], `slot "${o.text.slot}" has kind ${sl.kind}, expected text`);
      }
      if (o.source && (o.kind === "image" || o.kind === "video")) checkSource(o.source, o.kind, ["overlays", i, "source"]);
      if (o.fontFileId !== undefined && !fontRefs.has(o.fontFileId)) issue(["overlays", i, "fontFileId"], `fontFileId "${o.fontFileId}" is not a fonts[] assetRef`);
    });
    s.fonts.forEach((f, i) => {
      const a = assets.get(f.assetRef);
      if (!a || a.kind !== "font") issue(["fonts", i, "assetRef"], `font asset "${f.assetRef}" missing or not kind font`);
    });
    s.audioClips.forEach((c, i) => {
      checkSource(c.source, "audio", ["audioClips", i, "source"], c.kind === "inline" ? "video" : undefined);
      if (c.linkedOverlayId !== undefined && overlayKinds.get(c.linkedOverlayId) !== "video") {
        issue(["audioClips", i, "linkedOverlayId"], `linkedOverlayId "${c.linkedOverlayId}" is not a video overlay key`);
      }
      for (const k of c.duck?.sidechainClipIds ?? []) {
        if (!clipKeys.has(k)) issue(["audioClips", i, "duck", "sidechainClipIds"], `sidechainClipIds names unknown clip "${k}"`);
      }
    });
  });

/**
 * What a VALID scaffold looks like, inferred from the schema. Structural: an
 * overlay is one flat object whose kind-specific fields are all optional.
 * A reader with no piece model — libi-site — uses these. App code does NOT:
 * it imports `TemplateScaffold` / `TemplateOverlay` / `TemplateAudioClip` from
 * lib/templates/scaffold.ts, which types an overlay per kind off
 * `PersistedOverlay` under the same names. The two do not assign to each other.
 */
export type TemplateScaffold = z.output<typeof templateScaffoldSchema>;
export type TemplateOverlay = TemplateScaffold["overlays"][number];
export type TemplateAudioClip = TemplateScaffold["audioClips"][number];

/**
 * The SHA-256 of this file with this constant blanked. libi and libi-site each
 * hold a byte-identical copy at lib/templates/scaffold-schema.ts, and each
 * repo's test recomputes the hash over ITS OWN copy. So the pin catches an
 * edit that was not re-pinned, in the repo where it was made. It cannot see
 * the other repo: an edit re-pinned here and never copied there leaves both
 * repos green.
 *
 * Drift between the repos is caught at runtime instead. The app sends this
 * hash with every publish, and the site accepts only the hashes in its
 * supported list, refusing any other with a message telling the user to
 * update libi. So a change here means: re-pin, copy the file to the other
 * repo, and add the new hash to the site's supported list.
 *
 * Recompute with: node -e 'const s=require("fs").readFileSync("lib/templates/scaffold-schema.ts","utf8").replace(/SCAFFOLD_SCHEMA_SHA256 = "[0-9a-f]*"/,"SCAFFOLD_SCHEMA_SHA256 = \"\"");console.log(require("crypto").createHash("sha256").update(s).digest("hex"))'
 */
export const SCAFFOLD_SCHEMA_SHA256 = "f035fe0b2ad4de833ecf536d8defd9b0827fba993490ec940cd76390f2fce628";

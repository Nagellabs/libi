/**
 * Piece → template scaffold (spec §4 extract). Pure planning: it returns the
 * scaffold plus the files to copy/write; `lib/templates/store.ts` does the
 * writing. Loads the manifest HYDRATED so code bodies are in memory.
 *
 * Three namespaces, each unique on its own (the scaffold schema checks them
 * separately, so an overlay key and an asset ref may read the same):
 *  - overlay + clip KEYS, slugged from `displayName` / `label`;
 *  - asset REFS, slugged from the file's `name`;
 *  - slot keys, which the caller supplies.
 */
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { loadManifest, type PersistedOverlay } from "@/lib/composition/persistence";
import { readTrack } from "@/lib/tracking/storage";
import { cssFamilyForFontFile } from "@/lib/fonts/family";
import { getUserPreset } from "@/lib/overlays/preset-store";
import { serverLogger as logger } from "@/lib/logger";
import { extensionForType, mediaTypeFor } from "@/lib/http/media-types";
import { effectiveRights, isCopyrighted } from "@/lib/audio-rights/read";
import { songLabel } from "@/lib/audio-rights/types";
import { hostedUrlProblem } from "@/lib/templates/cloud/preflight";
import type { TemplateMusicLink } from "@/lib/templates/scaffold-schema";
import {
  TEMPLATE_KEY_RE,
  TEMPLATE_LIMITS,
  codeFileFor,
  type TemplateAsset,
  type TemplateAudioClip,
  type TemplateOverlay,
  type TemplateScaffold,
  type TemplateSlot,
} from "@/lib/templates/scaffold";

export interface ExtractSlotSpec {
  key: string;
  kind: TemplateSlot["kind"];
  label: string;
  hint?: string;
  required?: boolean;
  /** Overlay KEY (slug) or overlay ID; a clip KEY for an `audio` slot. */
  fromOverlayKey?: string;
}

export interface ExtractOptions {
  overlayIds?: string[];
  slots?: ExtractSlotSpec[];
}

export interface ExtractResult {
  scaffold: TemplateScaffold;
  copies: Array<{ rel: string; from: string }>;
  writes: Array<{ rel: string; body: string }>;
  /** "## Tracking to re-do" section text, "" when the piece had no tracked overlay. */
  trackingAppendix: string;
  /** overlayId → key, so callers can map a slot's `fromOverlayKey` given by overlay id too. */
  keyByOverlayId: Record<string, string>;
  /** Files the template could not carry (outside the media allowlist), and what
   *  became of the layers that used them. Empty when nothing was skipped. */
  warnings: string[];
}

const KEY_MAX = 40;

/** Everything a `tracked` overlay carries that a `code` overlay must not: the
 *  track reference, the tracked payload, and the follow parameters. */
const TRACKED_ONLY_KEYS = [
  "id", "trackId", "content", "fit", "scale", "smoothing",
  "sizeMode", "maxBoxScale", "positionMode", "offset", "caption",
] as const;

/** Trim to `KEY_MAX` without leaving the trailing `-` a cut can expose. */
function clampKey(s: string): string {
  return s.slice(0, KEY_MAX).replace(/-+$/g, "");
}

/** Lowercase, non-alphanumerics → "-", trimmed, ≤ 40 chars, letter-first. */
export function slugifyKey(name: string, fallback: string): string {
  let slug = clampKey(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  );
  if (slug.length === 0) return fallback;
  if (!/^[a-z]/.test(slug)) slug = clampKey(`${fallback}-${slug}`);
  return TEMPLATE_KEY_RE.test(slug) ? slug : fallback;
}

/** `base`, or `base-2`/`base-3`/… when taken. Records the result in `taken`. */
export function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${clampKey(base.slice(0, KEY_MAX - suffix.length))}${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

type TrackedOverlay = Extract<PersistedOverlay, { kind: "tracked" }>;

/** Every character JS treats as a line terminator. One of them inside a `//`
 *  comment ends the comment, so whatever follows it would run as body code. */
const LINE_TERMINATORS_RE = /[\r\n\u2028\u2029]+/g;

/** A tracked label, a `displayName` or a track id is template-derived text;
 *  it goes into the stand-in body only inside a one-line `//` comment. */
function commentSafe(label: string): string {
  return label.replace(LINE_TERMINATORS_RE, " ").replace(/"/g, "'");
}

/** A code body a tracked overlay with non-code content becomes (spec §3.5:
 *  "a code overlay with the same body and rect" — for emoji/text/image/video/
 *  effect content there is no body, so this stand-in names what was there). */
export function placeholderBodyFor(content: TrackedOverlay["content"], label: string): string {
  const what = content.kind === "emoji" ? content.char : content.kind === "text" ? content.content : `${content.kind}`;
  // JSON.stringify escapes \r and \n but not U+2028/U+2029. Both are legal in
  // a string literal since ES2019; escape them anyway so the literal stays on
  // one line for every reader of the file, not just the engine.
  const escaped = JSON.stringify(what).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return [
    `// Was a TRACKED ${content.kind} overlay following "${commentSafe(label)}" — re-track it with`,
    `// libi.tracked_overlay({ action: 'add' }), then remove this stand-in. See "Tracking to re-do" in index.md.`,
    "const { ctx, width, height } = context;",
    "ctx.save();",
    "ctx.font = `${Math.round(height * 0.5)}px sans-serif`;",
    "ctx.textAlign = 'center';",
    "ctx.textBaseline = 'middle';",
    "ctx.fillStyle = '#ffffff';",
    `ctx.fillText(${escaped}, width / 2, height / 2);`,
    "ctx.restore();",
  ].join("\n");
}

/** A shallow copy without `keys` — the piece-scoped fields a scaffold overlay
 *  or clip may not carry. Returns a plain object; the caller casts to the
 *  scaffold shape it is building and `validateScaffold` has the last word. */
function omit(o: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}

export async function extractScaffold(pieceId: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const db = getDb();
  const storage = await getStorage();
  const manifest = await loadManifest(pieceId);
  const log = logger.child({ tag: "templates", op: "extract", pieceId });

  const wanted = opts.overlayIds ? new Set(opts.overlayIds) : null;
  const overlaysIn = (manifest.overlays ?? []).filter((o) => !wanted || wanted.has(o.id));
  if (wanted && overlaysIn.length !== wanted.size) {
    const missing = [...wanted].filter((id) => !overlaysIn.some((o) => o.id === id));
    throw new Error(`overlay_not_found: ${missing.join(", ")}`);
  }
  const keptOverlayIds = new Set(overlaysIn.map((o) => o.id));

  // Keys. Overlays and clips share one namespace so a template never reads as
  // if a clip and an overlay were the same layer.
  const taken = new Set<string>();
  const keyByOverlayId: Record<string, string> = {};
  overlaysIn.forEach((o, i) => {
    const kind = o.kind === "tracked" ? "code" : o.kind;
    keyByOverlayId[o.id] = uniqueKey(slugifyKey(o.displayName ?? "", `${kind}-${i + 1}`), taken);
  });

  // Slots, pass 1 — the OVERLAY ones. Audio slots wait for the clip keys, which
  // in turn wait for `mediaSlotByKey` (a slot-replaced video overlay takes its
  // inline clip with it), so the pass is split rather than the order fudged.
  const slots: TemplateSlot[] = [];
  const textSlotByKey = new Map<string, string>();
  const mediaSlotByKey = new Map<string, string>();
  const clipSlotByKey = new Map<string, string>();
  const kindOfKey = new Map<string, string>(
    overlaysIn.map((o) => [keyByOverlayId[o.id], o.kind === "tracked" ? "code" : o.kind]),
  );
  const audioSlotSpecs: ExtractSlotSpec[] = [];
  for (const spec of opts.slots ?? []) {
    slots.push({
      key: spec.key,
      kind: spec.kind,
      label: spec.label,
      ...(spec.hint ? { hint: spec.hint } : {}),
      required: spec.required ?? false,
    });
    if (!spec.fromOverlayKey) continue;
    if (spec.kind === "audio") {
      audioSlotSpecs.push(spec);
      continue;
    }
    const key = keyByOverlayId[spec.fromOverlayKey] ?? (kindOfKey.has(spec.fromOverlayKey) ? spec.fromOverlayKey : undefined);
    if (!key) throw new Error(`slot "${spec.key}": fromOverlayKey "${spec.fromOverlayKey}" names no overlay`);
    const kind = kindOfKey.get(key);
    if (kind !== spec.kind) throw new Error(`slot "${spec.key}": overlay "${key}" has kind ${kind}, slot kind is ${spec.kind}`);
    (spec.kind === "text" ? textSlotByKey : mediaSlotByKey).set(key, spec.key);
  }

  // Files a template cannot carry. The media allowlist (lib/http/media-types.ts)
  // decides the type an asset is stored and served as, so a file outside it —
  // HEIC, BMP, AVI, AIFF, or not media at all — is not copied. Rather than fail
  // the whole template, the layer that used it becomes an UNFILLED SLOT of its
  // kind (the user supplies their own file on apply); with no slot left under
  // the cap, the layer is dropped. Either way the create result says so.
  const warnings: string[] = [];
  const fileRow = (fileId: string) => {
    const row = db.select().from(files).where(eq(files.id, fileId)).get();
    if (!row) throw new Error(`file_not_found: ${fileId}`);
    return row;
  };
  /** The allowlisted extension a file of `kind` is carried under, or null. A
   *  file stored under an odd name (`download-0.bin`) takes the extension of
   *  its recorded type. */
  const carriedExt = (row: { filename: string; contentType: string | null }, kind: TemplateAsset["kind"]): string | null => {
    const ext = path.extname(row.filename).toLowerCase();
    if (mediaTypeFor(kind, `f${ext}`) !== null) return ext;
    return extensionForType(kind, row.contentType);
  };
  const slotKeys = new Set(slots.map((sl) => sl.key));
  const autoSlotByFile = new Map<string, string>();
  const droppedOverlayIds = new Set<string>();
  /** The slot standing in for an uncarriable file, minted once per (kind,
   *  file); null when the slot cap is reached. */
  const slotForUncarriable = (
    fileId: string,
    kind: TemplateSlot["kind"],
    owner: { key: string; label: string },
    filename: string,
    why = `not an allowed ${kind} file`,
  ): string | null => {
    const memo = autoSlotByFile.get(`${kind}:${fileId}`);
    if (memo) return memo;
    if (slots.length >= TEMPLATE_LIMITS.slots) return null;
    const key = uniqueKey(slugifyKey(owner.key, kind), slotKeys);
    slots.push({
      key,
      kind,
      label: owner.label.slice(0, 80) || key,
      hint: `The source used ${filename.slice(0, 120)}, which a template cannot carry (${why}). Supply your own.`,
      required: false,
    });
    autoSlotByFile.set(`${kind}:${fileId}`, key);
    return key;
  };
  for (const o of overlaysIn) {
    if (o.kind !== "image" && o.kind !== "video") continue;
    const key = keyByOverlayId[o.id];
    if (mediaSlotByKey.has(key)) continue;
    const row = fileRow(o.fileId);
    // A video whose sound is a copyrighted song never travels either
    // (social-music spec §7): the user supplies their own footage.
    const copyrighted = o.kind === "video" && isCopyrighted(row);
    if (carriedExt(row, o.kind) !== null && !copyrighted) continue;
    const why = copyrighted ? "it carries copyrighted audio" : `not an allowed ${o.kind} file`;
    const skipped = copyrighted ? "carries copyrighted audio" : `is not an allowed ${o.kind} file`;
    const slotKey = slotForUncarriable(o.fileId, o.kind, { key, label: o.displayName ?? row.name ?? key }, row.filename, why);
    if (slotKey) {
      mediaSlotByKey.set(key, slotKey);
      warnings.push(`asset skipped: ${row.filename} ${skipped}; ${o.kind} overlay "${key}" is now the unfilled slot "${slotKey}"`);
    } else {
      droppedOverlayIds.add(o.id);
      warnings.push(`asset skipped: ${row.filename} ${skipped}; ${o.kind} overlay "${key}" was dropped (no slot left under the ${TEMPLATE_LIMITS.slots}-slot cap)`);
    }
  }
  if (droppedOverlayIds.size > 0) {
    for (let i = overlaysIn.length - 1; i >= 0; i--) if (droppedOverlayIds.has(overlaysIn[i].id)) overlaysIn.splice(i, 1);
    for (const id of droppedOverlayIds) keptOverlayIds.delete(id);
  }

  // An inline clip is the audio track of ONE video overlay. It is dropped both
  // when that overlay is excluded by `overlayIds` and when a slot replaces it:
  // the video the user supplies brings its own audio, and keeping the clip
  // would lay the template author's soundtrack under the user's footage.
  const clipsIn = (manifest.audioClips ?? []).filter((c) => {
    if (!c.linkedOverlayId) return true;
    if (!keptOverlayIds.has(c.linkedOverlayId)) return false;
    return !mediaSlotByKey.has(keyByOverlayId[c.linkedOverlayId]);
  });
  const keyByClipId: Record<string, string> = {};
  clipsIn.forEach((c, i) => {
    keyByClipId[c.id] = uniqueKey(slugifyKey(c.label ?? "", `clip-${i + 1}`), taken);
  });

  // Slots, pass 2 — the AUDIO ones, now that the surviving clips have keys.
  const clipKeys = new Set(Object.values(keyByClipId));
  for (const spec of audioSlotSpecs) {
    const clipKey = keyByClipId[spec.fromOverlayKey!] ?? (clipKeys.has(spec.fromOverlayKey!) ? spec.fromOverlayKey! : undefined);
    if (!clipKey) throw new Error(`slot "${spec.key}": fromOverlayKey "${spec.fromOverlayKey}" names no audio clip`);
    clipSlotByKey.set(clipKey, spec.key);
  }

  // Assets, one per FILE. A video that also feeds an inline clip is NOT copied
  // twice: the clip's `source` names the same `video` asset, which the scaffold
  // schema allows for `kind: "inline"` only (`checkSource`). `acceptKind` is
  // how a caller says which existing kind it will take — an inline clip asks
  // for `audio` and accepts `video`.
  const assets: TemplateAsset[] = [];
  const copies: ExtractResult["copies"] = [];
  const assetByFileId = new Map<string, TemplateAsset>();
  const takenRefs = new Set<string>();
  let fontCount = 0;
  const assetFor = (fileId: string, kind: TemplateAsset["kind"], acceptKind?: TemplateAsset["kind"]): string => {
    const known = assetByFileId.get(fileId);
    if (known && (known.kind === kind || known.kind === acceptKind)) return known.ref;
    const row = fileRow(fileId);
    // The asset's extension is what its content type is derived from on apply
    // (lib/http/media-types.ts), so it has to be one the kind allows. Every
    // caller has already turned an uncarriable file into a slot or a warning.
    const ext = carriedExt(row, kind);
    if (!ext) throw new Error(`asset_type_unsupported: ${row.filename} is not an allowed ${kind} file`);
    const base = kind === "font" ? `font-${++fontCount}` : slugifyKey(row.name, `${kind}-${assets.length + 1}`);
    const ref = uniqueKey(takenRefs.has(base) ? clampKey(`${base}-${kind}`) : base, takenRefs);
    const rel = `assets/${ref}${ext}`;
    const asset: TemplateAsset = { ref, kind, file: rel, contentType: mediaTypeFor(kind, rel)! };
    assets.push(asset);
    copies.push({ rel, from: storage.localPath(row.pieceId ?? null, row.filename) });
    // A file needed under two kinds that CANNOT share (a standalone clip on a
    // video file) keeps the first asset as the memo and copies the bytes again.
    if (!known) assetByFileId.set(fileId, asset);
    return ref;
  };

  const overlays: TemplateOverlay[] = [];
  const writes: ExtractResult["writes"] = [];
  const fonts: TemplateScaffold["fonts"] = [];
  const captionStyles = new Map<string, Record<string, unknown>>();
  const trackingRedo: string[] = [];

  // A scaffold overlay never carries `caption` (it holds a piece-scoped
  // `groupId` and is footage-specific). Its reusable half travels as
  // `captionStyles[]` — inlined here from the USER preset a `styleRef` names.
  // A bundled id resolves to no user preset and is simply skipped.
  for (const o of overlaysIn) {
    const styleRef = (o as { caption?: { styleRef?: string } }).caption?.styleRef;
    if (!styleRef || captionStyles.has(styleRef)) continue;
    const preset = await getUserPreset(styleRef);
    if (preset) captionStyles.set(styleRef, preset.fields);
  }

  for (const o of overlaysIn) {
    const key = keyByOverlayId[o.id];
    if (o.kind === "text") {
      const out = {
        ...omit(o, ["id", "content", "fontFileId", "caption"]),
        key,
        text: textSlotByKey.has(key) ? { slot: textSlotByKey.get(key)! } : { fixed: o.content },
      } as TemplateOverlay;
      const fontRow = o.fontFileId ? fileRow(o.fontFileId) : null;
      if (fontRow && carriedExt(fontRow, "font") === null) {
        warnings.push(`asset skipped: ${fontRow.filename} is not an allowed font file; text overlay "${key}" renders in a fallback face`);
      } else if (o.fontFileId) {
        const ref = assetFor(o.fontFileId, "font");
        if (!fonts.some((f) => f.assetRef === ref)) fonts.push({ family: cssFamilyForFontFile(o.fontFileId), assetRef: ref });
        (out as { fontFileId?: string }).fontFileId = ref;
      }
      overlays.push(out);
    } else if (o.kind === "image" || o.kind === "video") {
      const source = mediaSlotByKey.has(key) ? { slot: mediaSlotByKey.get(key)! } : { assetRef: assetFor(o.fileId, o.kind) };
      overlays.push({ ...omit(o, ["id", "fileId"]), key, source } as TemplateOverlay);
    } else if (o.kind === "code") {
      const codeFile = codeFileFor("code", key);
      writes.push({ rel: codeFile, body: o.drawFunction });
      overlays.push({ ...omit(o, ["id", "drawFunction", "caption"]), key, codeFile } as TemplateOverlay);
    } else if (o.kind === "three") {
      const codeFile = codeFileFor("three", key);
      writes.push({ rel: codeFile, body: o.sceneFunction });
      overlays.push({ ...omit(o, ["id", "sceneFunction", "caption"]), key, codeFile } as TemplateOverlay);
    } else {
      // tracked → code (spec §3.5). A track is footage-specific and cannot
      // travel, so the layer keeps its rect/timing/z/opacity and the appendix
      // tells the reader what to re-track.
      const track = await readTrack(pieceId, o.trackId).catch(() => null);
      const label = track?.label ?? o.displayName ?? o.trackId;
      const codeFile = codeFileFor("code", key);
      const content = o.content;
      writes.push({ rel: codeFile, body: content.kind === "code" ? content.drawFunction : placeholderBodyFor(content, label) });
      overlays.push({ ...omit(o, TRACKED_ONLY_KEYS), kind: "code", key, codeFile } as TemplateOverlay);
      trackingRedo.push(
        `- \`${key}\` followed **${label}** (${content.kind} content, fit \`${o.fit}\`, scale ${o.scale}); ` +
          "re-track it with `libi.tracked_overlay({ action: 'add' })` and remove the stand-in code overlay.",
      );
    }
  }

  // A clip on a file the audio kind cannot carry becomes an audio slot too; a
  // clip with neither a file nor a slot is not renderable, so it is dropped.
  const droppedClipIds = new Set<string>();
  for (const c of clipsIn) {
    const key = keyByClipId[c.id];
    if (clipSlotByKey.has(key)) continue;
    const row = fileRow(c.fileId);
    if (carriedExt(row, "audio") !== null) continue;
    const slotKey = slotForUncarriable(c.fileId, "audio", { key, label: c.label ?? row.name ?? key }, row.filename);
    if (slotKey) {
      clipSlotByKey.set(key, slotKey);
      warnings.push(`asset skipped: ${row.filename} is not an allowed audio file; audio clip "${key}" is now the unfilled slot "${slotKey}"`);
    } else {
      droppedClipIds.add(c.id);
      warnings.push(`asset skipped: ${row.filename} is not an allowed audio file; audio clip "${key}" was dropped (no slot left under the ${TEMPLATE_LIMITS.slots}-slot cap)`);
    }
  }

  // A copyrighted song is NAMED, never carried (social-music spec §7).
  const musicLinks: TemplateMusicLink[] = [];
  const musicRefByFile = new Map<string, string>();
  const musicLinkFor = (fileId: string): string => {
    const known = musicRefByFile.get(fileId);
    if (known) return known;
    const row = fileRow(fileId);
    const rights = effectiveRights(row);
    // `||`, not `??`: an empty name is no title (the scaffold's track.title is min 1).
    const title = (rights?.track?.title || row.name || row.filename).slice(0, 120);
    const artist = rights?.track?.artist?.slice(0, 120);
    const url = rights?.source?.url;
    // Kept only when the scaffold would take it: a hosted https link within its url cap.
    const keepUrl = !!url && hostedUrlProblem(url) === null && Buffer.byteLength(url, "utf8") <= TEMPLATE_LIMITS.urlBytes;
    const ref = uniqueKey(slugifyKey(title, "music"), takenRefs);
    const link: TemplateMusicLink = {
      ref,
      track: { title, ...(artist ? { artist } : {}) },
      ...(keepUrl ? { sourceUrl: url } : {}),
    };
    musicLinks.push(link);
    musicRefByFile.set(fileId, ref);
    warnings.push(`music not included: ${songLabel(link.track)}; applying the template leaves it out until the agent fetches it`);
    return ref;
  };

  const audioClips: TemplateAudioClip[] = clipsIn.filter((c) => !droppedClipIds.has(c.id)).map((c) => {
    const key = keyByClipId[c.id];
    const out: TemplateAudioClip = {
      ...omit(c, ["id", "fileId", "linkedOverlayId", "duck"]),
      key,
      // An inline clip follows its video: a copyrighted video became a slot
      // above, and its inline clip went with it.
      source: clipSlotByKey.has(key)
        ? { slot: clipSlotByKey.get(key)! }
        : c.kind !== "inline" && isCopyrighted(fileRow(c.fileId))
          ? { musicRef: musicLinkFor(c.fileId) }
          : { assetRef: assetFor(c.fileId, "audio", c.kind === "inline" ? "video" : undefined) },
    } as TemplateAudioClip;
    if (c.linkedOverlayId) out.linkedOverlayId = keyByOverlayId[c.linkedOverlayId];
    const duck = c.duck;
    if (duck) {
      // `sidechainClipId` (singular) holds a real clip ID, never a key — the
      // schema rejects it, and `loadManifest` has already folded it into the
      // plural. `sidechainClipIds` is always written, `[]` when none survive.
      out.duck = {
        ...omit(duck, ["sidechainClipId", "sidechainClipIds"]),
        sidechainClipIds: (duck.sidechainClipIds ?? [])
          .filter((id) => !droppedClipIds.has(id))
          .map((id) => keyByClipId[id])
          .filter((k): k is string => !!k),
      } as NonNullable<TemplateAudioClip["duck"]>;
    }
    return out;
  });

  const end = (s: { startTime: number; duration: number }) => s.startTime + s.duration;
  const duration = Math.max(0, ...overlays.map(end), ...audioClips.map(end));
  const trackingAppendix = trackingRedo.length
    ? [
        "## Tracking to re-do",
        "",
        "These layers followed a moving subject in the source piece; a template cannot carry a track.",
        "",
        ...trackingRedo,
        "",
      ].join("\n")
    : "";

  // `name` is a placeholder the caller replaces (`createTemplate` overrides
  // name/description/tags), but it may not be empty — the schema wants 1–80
  // chars, and extract's own result has to validate.
  const piece = db.select({ name: pieces.name }).from(pieces).where(eq(pieces.id, pieceId)).get();

  const scaffold: TemplateScaffold = {
    schema: 1,
    name: piece?.name?.trim().slice(0, TEMPLATE_LIMITS.nameChars) || "Untitled template",
    description: "",
    tags: [],
    canvas: { width: manifest.width, height: manifest.height, fps: manifest.fps },
    duration,
    slots,
    overlays,
    audioClips,
    assets,
    ...(musicLinks.length > 0 ? { musicLinks } : {}),
    fonts,
    captionStyles: [...captionStyles].map(([id, fields]) => ({ id, fields })),
  };
  // Two kinds of warning, logged apart: a file the template cannot carry (not
  // an allowed type, or a video with copyrighted audio), and a song it names
  // but leaves out.
  const musicNotes = warnings.filter((w) => w.startsWith("music not included:"));
  const skippedNotes = warnings.filter((w) => !w.startsWith("music not included:"));
  log.info(
    { overlays: overlays.length, clips: audioClips.length, assets: assets.length, tracked: trackingRedo.length, skipped: skippedNotes.length, musicLinks: musicLinks.length },
    "scaffold extracted",
  );
  if (skippedNotes.length > 0) log.warn({ warnings: skippedNotes }, "assets skipped: the template cannot carry them");
  if (musicNotes.length > 0) log.info({ warnings: musicNotes }, "copyrighted music named by the template, not included");
  return { scaffold, copies, writes, trackingAppendix, keyByOverlayId, warnings };
}

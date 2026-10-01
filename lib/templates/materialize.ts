/**
 * Template scaffold → piece (spec §4 materialize). Reuses the piece's own
 * primitives: `storeFile` for bytes, `saveManifest` (which writes the code
 * files) for the composition, the caller's `fetchUrls` for hosted media (the
 * MCP tool hands it the `remote_fetch` job, so the SSRF guard and the byte cap
 * apply to a URL a template author chose).
 *
 * The three id conventions a scaffold uses (see scaffold.ts) are rewritten
 * here, and only here: a text overlay's `fontFileId` is a font ASSET ref, a
 * clip's `linkedOverlayId` is an overlay KEY, and `duck.sidechainClipIds` are
 * clip KEYS.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { and, eq, isNull, or } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getStorage } from "@/lib/storage";
import { files, pieces } from "@/lib/db/schema/sqlite";
import {
  loadManifest,
  saveManifest,
  type PersistedAudioClip,
  type PersistedOverlay,
} from "@/lib/composition/persistence";
import { articleFor, fileCategoryOf, storeFile } from "@/mcp/tools/file-tools";
import { ownedByProvenance } from "@/lib/audio-rights/stamp";
import { getUserPreset, saveUserPreset } from "@/lib/overlays/preset-store";
import { CAPTION_STYLES } from "@/lib/captions/styles";
import { cssFamilyForFontFile, withFamily } from "@/lib/fonts/family";
import { serverLogger as logger } from "@/lib/logger";
import { validateDrawFunction, validateThreeFunction } from "@/lib/ai/scene-validator";
import { unfilledSlotDisplayName, unfilledSlotFileId } from "./unfilled-slot";
import { extensionOf, mediaTypeFor } from "@/lib/http/media-types";
import { CLIP_KEYS, OVERLAY_KEYS_BY_KIND, captionStyleFields, pickKeys } from "@/lib/templates/fields";
import { leftOutList, neutraliseClip, neutraliseLook, neutraliseOverlay, neutralSlotName, newNeutraliseContext } from "@/lib/templates/author-text";
import {
  TEMPLATE_LIMITS,
  type TemplateScaffold,
  type TemplateSlot,
  type TemplateSource,
} from "@/lib/templates/scaffold";
import { TEMPLATES_LOG_TAG, getTemplate, readScaffold, readTemplateFile, recordUse } from "@/lib/templates/store";
import type { PendingMusic, PendingMusicClip } from "@/lib/templates/pending-music";
import { hostedUrlProblem } from "@/lib/templates/cloud/preflight";

/** Downloads hosted assets / slot urls into the piece and answers per url.
 *  The MCP tool passes a `remote_fetch` job runner with `mediaOnly: true`, so
 *  the type a download is stored under is derived from the media allowlist
 *  (`lib/http/media-types.ts#safeStoredMediaType`), never taken from what the
 *  remote server declared, and a non-media download is refused. A test passes a
 *  stub. `filenames` (url → name) is set for a stranger's hosted assets: the
 *  name the file is stored under, instead of the url's own basename, which the
 *  author chose. */
export type UrlFetcher = (
  urls: string[],
  filenames?: Readonly<Record<string, string>>,
) => Promise<Array<{ url: string; fileId?: string; error?: string }>>;

/** The neutral name a stranger's asset is stored under: its position, and an extension only the allowlist admits. */
function templateAssetName(n: number, ext: string): string {
  return `template-asset-${n}${ext}`;
}

export interface ApplyScaffoldInput {
  templateId: string;
  pieceId: string;
  slotValues?: Record<string, string>;
  mode?: "append" | "replace";
  /** Called AT MOST ONCE, with every url the apply needs. */
  fetchUrls: UrlFetcher;
}

export interface ApplyScaffoldResult {
  pieceId: string;
  /** scaffold key → the overlay id minted for it. */
  overlays: Record<string, string>;
  /** scaffold key → the clip id minted for it. */
  clips: Record<string, string>;
  unfilledSlots: TemplateSlot[];
  warnings: string[];
  /** What was left out of a stranger's template because libi does not have or
   *  recognise it, one line per place and kind ("layer 3 (text-ab12cd34): exit effect not
   *  available"): libi's words, never the author's value. Empty for the user's
   *  own template, which is applied as it is. */
  leftOut: string[];
  /** Songs left out (the template names them; the agent fetches on the user's yes). */
  pendingMusic: PendingMusic[];
}

/** The description a template's stored asset carries in the piece: libi's words
 *  (the template's id and version, the asset's position), and what lets a later
 *  apply of the same version reuse the file instead of storing it again. */
function storedAssetMark(templateId: string, version: number, n: number): string {
  return `Copied from template ${templateId} v${version}, asset ${n}`;
}

/** The id of a file in `pieceId` carrying `mark` whose bytes are exactly
 *  `buffer` (sha256), or null. Size narrows the candidates before any read. */
async function storedCopy(pieceId: string, mark: string, buffer: Buffer): Promise<string | null> {
  const candidates = getDb()
    .select({ id: files.id, filename: files.filename })
    .from(files)
    .where(and(eq(files.pieceId, pieceId), eq(files.description, mark), eq(files.size, buffer.byteLength)))
    .all();
  if (candidates.length === 0) return null;
  const want = sha256(buffer);
  const storage = await getStorage();
  for (const c of candidates) {
    try {
      if (sha256(await fs.readFile(storage.localPath(pieceId, c.filename))) === want) return c.id;
    } catch {
      // Gone or unreadable on disk: not a copy to reuse.
    }
  }
  return null;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Same prefixes `mcp/tools/overlay-tools.ts#newId` mints, so an overlay from a
 *  template reads like any other in the timeline and the logs. */
const ID_PREFIX: Record<string, string> = { text: "text", image: "img", video: "vid", code: "code", three: "three" };

function rand(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function newTemplateOverlayId(kind: string): string {
  return `${ID_PREFIX[kind] ?? kind}-${rand()}`;
}

export function newTemplateClipId(): string {
  return `clip_${rand()}`;
}

function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** A shallow copy without `keys` — the scaffold-only fields that never belong
 *  on a persisted overlay or clip. */
function omit(o: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** Read and gate every code/three body BEFORE anything is written. Defense in
 *  depth, and the same gate `libi.add_overlay` applies to an agent-written body
 *  (`mcp/tools/overlay-tools.ts` → `lib/ai/scene-validator.ts`): `saveManifest`
 *  itself validates nothing, so a body that would fail at load must not reach
 *  the manifest. Running it first is what makes a rejected template a no-op —
 *  no copied files, no half-applied piece. */
async function readBodies(templateId: string, scaffold: TemplateScaffold): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  for (const t of scaffold.overlays) {
    if (t.kind !== "code" && t.kind !== "three") continue;
    const abs = await readTemplateFile(templateId, t.codeFile!);
    const stat = await fs.stat(abs);
    if (stat.size > TEMPLATE_LIMITS.codeFileBytes) throw new Error(`template_broken: ${t.codeFile} over 128 KB`);
    const body = await fs.readFile(abs, "utf8");
    const verdict = t.kind === "code" ? validateDrawFunction(body) : validateThreeFunction(body);
    if (!verdict.valid) throw new Error(`template_body_rejected: ${t.key}: ${verdict.error}`);
    bodies.set(t.key, body);
  }
  return bodies;
}

/** What `applyScaffold` throws. `partial` is true ONLY when the apply had
 *  already begun writing into the piece — storing a template asset, running the
 *  caller's download (which uploads into the piece), or saving the manifest —
 *  so a caller can warn that media may have been left behind. Every gate (a
 *  missing template or piece, a broken scaffold, an unknown slot, a rejected
 *  code body, an unreadable code file) throws before the first write and is
 *  never partial: a rejected template stays the documented no-op. */
export class ApplyError extends Error {
  readonly partial: boolean;
  constructor(message: string, partial: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApplyError";
    this.partial = partial;
  }
}

export async function applyScaffold(input: ApplyScaffoldInput): Promise<ApplyScaffoldResult> {
  const state = { wrote: false };
  try {
    return await applyInto(input, state);
  } catch (err) {
    if (err instanceof ApplyError) throw err;
    throw new ApplyError(err instanceof Error ? err.message : String(err), state.wrote, { cause: err });
  }
}

/** The apply itself. `state.wrote` flips at the first write into the piece and
 *  is read by `applyScaffold`'s wrapper — nothing else. */
async function applyInto(input: ApplyScaffoldInput, state: { wrote: boolean }): Promise<ApplyScaffoldResult> {
  const db = getDb();
  const log = logger.child({ tag: TEMPLATES_LOG_TAG, op: "apply", templateId: input.templateId, pieceId: input.pieceId });
  const row = getTemplate(input.templateId);
  if (!row) throw new Error("template_not_found");
  // A public or installed template's words are a STRANGER's. What this apply
  // copies into the user's piece is read back later by every piece and file
  // tool with no label, as if the user had written it — so every string it
  // would copy is neutralised field by field (lib/templates/author-text.ts:
  // names become libi's own, style values must be ones the renderer knows).
  // The fixed text the layers DISPLAY and font families are the template
  // itself and stay; the apply result labels them
  // (mcp/tools/template-tools.ts APPLY_AUTHOR_FIELDS.inPiece).
  const authored = row.origin !== "local";
  const neutral = newNeutraliseContext();
  if (!db.select({ id: pieces.id }).from(pieces).where(eq(pieces.id, input.pieceId)).get()) throw new Error("piece_not_found");
  const read = await readScaffold(input.templateId);
  if (!read.ok) throw new Error(`template_broken: ${read.reason}`);
  const scaffold = read.scaffold;

  const slotByKey = new Map(scaffold.slots.map((s) => [s.key, s]));
  /** What an unfilled slot is called in the piece: its label locally, its position for a stranger's template. */
  const slotName = (slot: TemplateSlot): string => (authored ? neutralSlotName(scaffold.slots.indexOf(slot) + 1) : slot.label);
  for (const key of Object.keys(input.slotValues ?? {})) {
    if (!slotByKey.has(key)) throw new Error(`slot_unknown: ${key}`);
  }
  const bodies = await readBodies(input.templateId, scaffold);

  const warnings: string[] = [];
  const unfilled = new Map<string, TemplateSlot>();

  // ── 1. Resolve every file the piece will need ───────────────────────────
  // Hosted urls (template assets and slot values alike) are collected and
  // handed to the caller in ONE call. The MCP tool runs them as `remote_fetch`
  // jobs of at most 20 urls each, one after another
  // (`lib/templates/fetch-in-chunks.ts`), so the agent sees one job at a time
  // instead of one per asset.
  const fileIdByAssetRef = new Map<string, string>();
  const pendingUrls: Array<{ url: string; filename?: string; onFile: (fileId: string) => void; onError: (msg: string) => void }> = [];

  for (const [assetIndex, a] of scaffold.assets.entries()) {
    if (a.file) {
      // The stored type is DERIVED from the extension and the asset's kind —
      // never the scaffold's free-text `contentType`, which could say
      // `text/html` and turn the bytes into a page in libi's origin. The
      // scaffold schema already refused an extension outside the allowlist.
      const contentType = mediaTypeFor(a.kind, a.file);
      if (!contentType) throw new Error(`template_broken: ${a.file} is not an allowed ${a.kind} file`);
      const abs = await readTemplateFile(input.templateId, a.file);
      const buffer = await fs.readFile(abs);
      // Already in this piece from an earlier apply of this template version
      // (a `replace` retried after a timeout, a second copy appended): reuse
      // it, so repeated applies do not pile up "template-asset-1 (1).png".
      // Only the same BYTES: an installed template replaced in place at the
      // same version can change an asset and keep its size.
      const mark = storedAssetMark(input.templateId, row.version, assetIndex + 1);
      const stored = await storedCopy(input.pieceId, mark, buffer);
      if (stored) {
        fileIdByAssetRef.set(a.ref, stored);
        continue;
      }
      state.wrote = true;
      const record = await storeFile({
        pieceId: input.pieceId,
        filename: authored ? `template-asset-${assetIndex + 1}${path.extname(a.file).toLowerCase()}` : path.basename(a.file),
        buffer,
        contentType,
        description: mark,
        // Bytes a template carries are never a copyrighted song: extract turns
        // one into a music link (or a video slot), and a public template's
        // audio and video arrive as hosted urls (remote_fetch stamps those
        // copyrighted). A scaffold records no rights, so the file's original
        // class is unknown here — owned is the reading that fits bytes that
        // passed extract. storeFile writes it only when the file carries audio.
        audioRights: ownedByProvenance(),
      });
      fileIdByAssetRef.set(a.ref, record.id);
    } else if (a.url) {
      // The url's basename is the author's choice; the extension is kept only
      // when the allowlist admits it for this kind (it decides the stored type).
      let urlName = "";
      try {
        urlName = path.posix.basename(new URL(a.url).pathname);
      } catch {
        // The fetch reports the bad url.
      }
      const ext = mediaTypeFor(a.kind, urlName) ? extensionOf(urlName) : "";
      pendingUrls.push({
        url: a.url,
        ...(authored ? { filename: templateAssetName(assetIndex + 1, ext) } : {}),
        onFile: (fileId) => fileIdByAssetRef.set(a.ref, fileId),
        onError: (msg) => warnings.push(`asset "${a.ref}" could not be fetched (${msg}); the layers using it were skipped`),
      });
    }
  }

  const pieceFile = (fileId: string) =>
    db
      .select({ type: files.type, contentType: files.contentType, filename: files.filename })
      .from(files)
      .where(and(eq(files.id, fileId), or(eq(files.pieceId, input.pieceId), isNull(files.pieceId))))
      .get();
  /** The same kind gate `add_overlay` / `update_overlay` apply: a media slot
   *  takes a file of its kind — an audio slot also takes a video (its sound
   *  track) — and a category still unknown passes. On a mismatch the slot is
   *  left unfilled with a warning, never a failed apply: the agent then fills
   *  it with update_overlay, which is gated the same way. */
  const slotKindMismatch = (
    slot: TemplateSlot,
    file: { type: string | null; contentType: string | null; filename: string | null },
  ): string | null => {
    const category = fileCategoryOf(file);
    if (category === "other" || category === slot.kind) return null;
    if (slot.kind === "audio" && category === "video") return null;
    return category;
  };
  const refuseSlotFile = (slot: TemplateSlot, what: string, category: string) => {
    unfilled.set(slot.key, slot);
    const needs = slot.kind === "audio" ? "audio or video" : slot.kind;
    warnings.push(`slot "${slot.key}": ${what} is ${articleFor(category)} ${category} file; this ${slot.kind} slot needs ${articleFor(needs)} ${needs} file`);
  };

  const slotFileId = new Map<string, string>();
  const slotText = new Map<string, string>();
  for (const slot of scaffold.slots) {
    const value = input.slotValues?.[slot.key];
    if (value === undefined || value === "") {
      unfilled.set(slot.key, slot);
      continue;
    }
    if (slot.kind === "text") {
      slotText.set(slot.key, value);
      continue;
    }
    const inPiece = pieceFile(value);
    if (inPiece) {
      const mismatch = slotKindMismatch(slot, inPiece);
      if (mismatch) refuseSlotFile(slot, `"${value}"`, mismatch);
      else slotFileId.set(slot.key, value);
    } else if (isHttpsUrl(value)) {
      pendingUrls.push({
        url: value,
        // The downloaded type is known only once it is stored.
        onFile: (fileId) => {
          const stored = pieceFile(fileId);
          const mismatch = stored ? slotKindMismatch(slot, stored) : null;
          if (mismatch) refuseSlotFile(slot, "the download", mismatch);
          else slotFileId.set(slot.key, fileId);
        },
        onError: (msg) => {
          unfilled.set(slot.key, slot);
          warnings.push(`slot "${slot.key}": download failed (${msg})`);
        },
      });
    } else {
      unfilled.set(slot.key, slot);
      warnings.push(`slot "${slot.key}": "${value}" is not a file of this piece and not an https URL`);
    }
  }

  if (pendingUrls.length > 0) {
    // Distinct urls: a template asset and a slot value may name the same file,
    // and each download spends the fetcher's size budget once.
    // `autoUpload` stores what it downloads INTO the piece, so the fetch is a
    // write even before the first byte comes back.
    state.wrote = true;
    const filenames: Record<string, string> = {};
    // A template asset comes first in `pendingUrls`, so its neutral name wins over a slot naming the same url.
    for (const p of pendingUrls) if (p.filename && !(p.url in filenames)) filenames[p.url] = p.filename;
    const urls = [...new Set(pendingUrls.map((p) => p.url))];
    const results = Object.keys(filenames).length > 0 ? await input.fetchUrls(urls, filenames) : await input.fetchUrls(urls);
    for (const p of pendingUrls) {
      const hit = results.find((r) => r.url === p.url);
      if (hit?.fileId) p.onFile(hit.fileId);
      else p.onError(hit?.error ?? "no result");
    }
  }

  // ── 2. Fonts and caption styles ─────────────────────────────────────────
  const fontFileIdByRef = new Map<string, string>();
  for (const f of scaffold.fonts) {
    const id = fileIdByAssetRef.get(f.assetRef);
    if (id) fontFileIdByRef.set(f.assetRef, id);
    else warnings.push(`font "${f.family}" was not available; the text using it renders in a fallback face`);
  }

  // A scaffold overlay carries no `caption` (footage-specific), so nothing here
  // points at a style. The styles travel so the agent can apply them when it
  // re-captions — registered under a template-suffixed id so a template can
  // never overwrite the user's own preset of the same name.
  //
  // The fields are filtered through the caption-style LOOK allowlist again here
  // (the scaffold schema already did it once): a registered preset is merged
  // over an overlay by `applyOverlayPreset`, so a `kind`, `id` or code key in it
  // would rewrite the layer — a text overlay into an unvalidated three one.
  const registeredStyles: string[] = [];
  for (const [styleIndex, cs] of scaffold.captionStyles.entries()) {
    if (CAPTION_STYLES.some((s) => s.id === cs.id)) {
      registeredStyles.push(cs.id);
      continue;
    }
    const look = { ...cs.fields };
    if (authored) neutraliseLook(look, neutral, { kind: "caption style", n: styleIndex + 1 });
    const fields = captionStyleFields(look);
    if (!fields) {
      warnings.push(`caption style "${cs.id}" was not registered: its fields are not a caption style`);
      continue;
    }
    const existing = await getUserPreset(cs.id);
    if (existing && JSON.stringify(existing.fields) === JSON.stringify(fields)) {
      registeredStyles.push(cs.id);
      continue;
    }
    const n = styleIndex + 1;
    const suffixed = authored ? `template-${input.templateId.slice(0, 8)}-style-${n}` : `${cs.id}-${input.templateId.slice(0, 8)}`.slice(0, 49);
    if (!(await getUserPreset(suffixed))) {
      await saveUserPreset({ id: suffixed, name: authored ? `Template style ${n}` : cs.id, kind: "text", source: "user", fields });
    }
    registeredStyles.push(suffixed);
  }
  if (registeredStyles.length > 0) warnings.push(`caption styles available: ${registeredStyles.join(", ")}`);

  // ── 3. Overlays ─────────────────────────────────────────────────────────
  const manifest = await loadManifest(input.pieceId);
  if (input.mode === "replace") {
    manifest.overlays = [];
    manifest.audioClips = [];
  }
  const existing = manifest.overlays ?? [];
  const existingClips = manifest.audioClips ?? [];
  const zOffset = existing.length === 0 ? 0 : Math.max(...existing.map((o) => o.z)) + 1;
  const overlayIdByKey: Record<string, string> = {};
  const outOverlays: PersistedOverlay[] = [];

  /** A `fileId`, the slot that still needs filling, or null when a hosted asset
   *  the layer needs never arrived (the layer is dropped). */
  const resolveSource = (
    src: TemplateSource,
    owner: string,
  ): { fileId: string } | { unfilledSlot: TemplateSlot } | null => {
    // A music link names a song and carries no file: a clip on one is recorded
    // as pending music by the clip loop, and the schema lets nothing else name one.
    if ("musicRef" in src) return null;
    if ("assetRef" in src) {
      const id = fileIdByAssetRef.get(src.assetRef);
      if (id) return { fileId: id };
      warnings.push(`"${owner}" skipped: asset "${src.assetRef}" is unavailable`);
      return null;
    }
    const id = slotFileId.get(src.slot);
    if (id) return { fileId: id };
    const slot = slotByKey.get(src.slot)!;
    unfilled.set(slot.key, slot);
    return { unfilledSlot: slot };
  };

  for (const [overlayIndex, t] of scaffold.overlays.entries()) {
    const key = t.key;
    const id = newTemplateOverlayId(t.kind);
    // Only this kind's allowlisted fields — the scaffold schema already
    // stripped the rest; this keeps a future caller that hands in an
    // unvalidated scaffold from persisting a marker like `unfilledSlot`.
    const base = omit(pickKeys(t as unknown as Record<string, unknown>, OVERLAY_KEYS_BY_KIND[t.kind]), ["key", "codeFile", "source", "text"]);
    base.id = id;
    base.z = t.z + zOffset;
    if (authored) neutraliseOverlay(base, neutral, overlayIndex + 1);
    if (t.kind === "text") {
      const slot = t.text && "slot" in t.text ? slotByKey.get(t.text.slot)! : null;
      const value = slot ? slotText.get(slot.key) : undefined;
      const placeholder = `${slot ? slotName(slot) : key} (fill me)`;
      base.content = t.text && "fixed" in t.text ? t.text.fixed : (value ?? placeholder);
      const fontRef = t.fontFileId;
      if (fontRef) {
        const newFontId = fontFileIdByRef.get(fontRef);
        if (newFontId) {
          base.fontFileId = newFontId;
          base.font = withFamily(String(base.font), cssFamilyForFontFile(newFontId));
        } else {
          // The family stays as authored; `saveManifest` warns that it will not
          // resolve, which is exactly what happened.
          delete base.fontFileId;
        }
      }
    } else if (t.kind === "image" || t.kind === "video") {
      const resolved = resolveSource(t.source!, key);
      if (resolved === null) continue;
      if ("fileId" in resolved) base.fileId = resolved.fileId;
      else {
        // A reserved placeholder id (see unfilled-slot.ts): the preview draws
        // the layer as a labelled "add media" box without fetching anything,
        // and export refuses until it is filled or hidden.
        const slot = resolved.unfilledSlot;
        base.fileId = unfilledSlotFileId(authored ? `slot-${scaffold.slots.indexOf(slot) + 1}` : slot.key);
        base.displayName = unfilledSlotDisplayName(slotName(slot));
        warnings.push(
          `slot "${resolved.unfilledSlot.key}" is unfilled: fill it with ` +
            `libi.update_overlay({ pieceId, overlayId: "${id}", fileId }) once you have the ${t.kind}`,
        );
      }
    } else {
      // Read and validated before a single byte was written (see readBodies).
      if (t.kind === "code") base.drawFunction = bodies.get(key)!;
      else base.sceneFunction = bodies.get(key)!;
    }
    overlayIdByKey[key] = id;
    outOverlays.push(base as unknown as PersistedOverlay);
  }

  // A clip on a music link names a copyrighted song the template never carries
  // (social-music spec §7): nothing is fetched now. The piece records the song
  // with the template's timing, and libi.fetch_template_music places it once the
  // user says yes. A stranger's link is named by its position, never its ref.
  const musicByRef = new Map((scaffold.musicLinks ?? []).map((m, i) => [m.ref, { link: m, n: i + 1 }]));
  const pending = new Map<string, PendingMusic>();
  // A pending clip's duck names scaffold keys too, re-minted with the rest below.
  const pendingDucks: Array<{ clip: PendingMusicClip; sidechainKeys: string[] }> = [];

  // ── 4. Clips ────────────────────────────────────────────────────────────
  // Two passes: a duck's sidechains and a clip's link are scaffold KEYS, and a
  // clip may name one that is minted after it.
  const clipIdByKey: Record<string, string> = {};
  const staged: Array<{ clip: PersistedAudioClip; sidechainKeys: string[]; linkedKey?: string }> = [];
  for (const [clipIndex, c] of scaffold.audioClips.entries()) {
    if ("musicRef" in c.source) {
      const named = musicByRef.get(c.source.musicRef);
      if (!named) continue; // the scaffold schema already refused this
      const { link, n } = named;
      const assetId = `tpl-${input.templateId.slice(0, 8)}-${authored ? `music-${n}` : link.ref}`;
      const entry = pending.get(assetId) ?? {
        assetId,
        templateId: input.templateId,
        track: { title: link.track.title, ...(link.track.artist ? { artist: link.track.artist } : {}) },
        ...(link.sourceUrl && hostedUrlProblem(link.sourceUrl) === null ? { sourceUrl: link.sourceUrl } : {}),
        clips: [],
      };
      const pendingClip: PendingMusicClip = { startTime: c.startTime, duration: c.duration, trimStart: c.trimStart, volume: c.volume, enabled: c.enabled };
      if (c.duck) {
        pendingClip.duck = { ...c.duck, sidechainClipIds: [] };
        pendingDucks.push({ clip: pendingClip, sidechainKeys: c.duck.sidechainClipIds ?? [] });
      }
      entry.clips.push(pendingClip);
      pending.set(assetId, entry);
      continue;
    }
    const resolved = resolveSource(c.source, c.key);
    if (resolved === null) continue;
    if (!("fileId" in resolved)) {
      // A clip with no file is not renderable, so there is nothing to create.
      warnings.push(
        `slot "${resolved.unfilledSlot.key}" is unfilled: add the audio with libi.audio_add_clip once you have it`,
      );
      continue;
    }
    if (c.linkedOverlayId && !overlayIdByKey[c.linkedOverlayId]) {
      warnings.push(`clip "${c.key}" skipped: its video layer "${c.linkedOverlayId}" was not created`);
      continue;
    }
    const id = newTemplateClipId();
    clipIdByKey[c.key] = id;
    const clip = omit(pickKeys(c as unknown as Record<string, unknown>, CLIP_KEYS), ["key", "source", "duck", "linkedOverlayId"]) as unknown as PersistedAudioClip;
    clip.id = id;
    if (authored) neutraliseClip(clip as unknown as Record<string, unknown>, neutral, clipIndex + 1);
    clip.fileId = resolved.fileId;
    if (c.duck) clip.duck = { ...c.duck, sidechainClipIds: [] };
    staged.push({ clip, sidechainKeys: c.duck?.sidechainClipIds ?? [], linkedKey: c.linkedOverlayId });
  }
  const outClips = staged.map(({ clip, sidechainKeys, linkedKey }) => {
    if (clip.duck) clip.duck.sidechainClipIds = sidechainKeys.map((k) => clipIdByKey[k]).filter((v): v is string => !!v);
    if (linkedKey) clip.linkedOverlayId = overlayIdByKey[linkedKey];
    return clip;
  });
  for (const { clip, sidechainKeys } of pendingDucks) {
    clip.duck!.sidechainClipIds = sidechainKeys.map((k) => clipIdByKey[k]).filter((v): v is string => !!v);
  }

  // The template's canvas wins on a piece with nothing in it (and on a replace,
  // which empties it). A piece the user has already built in keeps its own —
  // resizing it would rescale work the template knows nothing about.
  const pieceWasEmpty = existing.length === 0 && existingClips.length === 0;
  if (pieceWasEmpty || input.mode === "replace") {
    manifest.width = scaffold.canvas.width;
    manifest.height = scaffold.canvas.height;
    manifest.fps = scaffold.canvas.fps;
  } else if (manifest.width !== scaffold.canvas.width || manifest.height !== scaffold.canvas.height) {
    warnings.push(
      `the template was authored for ${scaffold.canvas.width}×${scaffold.canvas.height}; ` +
        `this piece is ${manifest.width}×${manifest.height}, so its layers may need repositioning`,
    );
  }

  manifest.overlays = [...existing, ...outOverlays];
  manifest.audioClips = [...existingClips, ...outClips];
  // Append merges by assetId (applying the same template again replaces its
  // entry); a replace starts the piece over, so only this apply's songs remain.
  const keptPending = input.mode === "replace" ? [] : (manifest.pendingMusic ?? []).filter((p) => !pending.has(p.assetId));
  const allPending = [...keptPending, ...pending.values()];
  if (allPending.length > 0) manifest.pendingMusic = allPending;
  else delete manifest.pendingMusic;
  state.wrote = true;
  await saveManifest(input.pieceId, manifest);
  recordUse(input.templateId, input.pieceId);

  const unfilledSlots = scaffold.slots.filter((s) => unfilled.has(s.key));
  const leftOut = leftOutList(neutral);
  log.info(
    {
      overlays: outOverlays.length,
      clips: outClips.length,
      unfilled: unfilledSlots.map((s) => s.key),
      mode: input.mode ?? "append",
      warnings: warnings.length,
      leftOut: leftOut.length,
    },
    "template applied",
  );
  if (pending.size > 0) {
    logger.info(
      { tag: "social-music", op: "template_music_pending", templateId: input.templateId, pieceId: input.pieceId, count: pending.size },
      "template music left out, pending",
    );
  }
  return { pieceId: input.pieceId, overlays: overlayIdByKey, clips: clipIdByKey, unfilledSlots, warnings, leftOut, pendingMusic: [...pending.values()] };
}

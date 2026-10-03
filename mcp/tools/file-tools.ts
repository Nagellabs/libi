/** File listing and storage tool implementations */

import path from "path";
import * as fs from "fs/promises";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { audioProxyVerdict, mayNeedAudioPreviewProxy } from "@/lib/ffmpeg/audio-preview";
import { alphaRecoverableInPreview } from "@/lib/ffmpeg/alpha";
import { getStorage } from "@/lib/storage";
import { moveDerivedArtifacts } from "@/lib/files/move-derived";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema";
import { enqueueJobOnServer, logProxyGenEnqueueFailure } from "@/mcp/jobs-client";
import { eq, isNull, desc, inArray } from "drizzle-orm";
import { navigationEmitter } from "@/lib/navigation-events";
import { parseAudioRights, serializeAudioRights, type AudioRights } from "@/lib/audio-rights/types";
import { parseAiGenerationMeta } from "@/lib/ai-generation/types";
import { derivedRights, effectiveRights, fileCarriesAudio } from "@/lib/audio-rights/read";
import { generatedStamp, uploadedStamp } from "@/lib/audio-rights/stamp";
import type { ToolContext, ToolResult } from "./types";
import { LIST_FILES_MAX_PIECES, type ListFilesParams, type DuplicateFileParams, type UploadFileParams, type SaveAssetParams } from "./schemas";
import type { FileRecord } from "@/lib/db/schema/types";
import { piecesByIds, piecesInFolder, resolveManyPieces, type TargetPiece } from "./piece-targets";

/**
 * RC-D: confirm a non-null target `pieceId` maps to a real `pieces` row before
 * writing bytes to `<storage>/<pieceId>/…`. The storage-layer format guard
 * (`assertSafePieceId`) blocks traversal-shaped ids; this blocks a well-formed
 * id that isn't an actual piece (so a write can only ever land in a directory
 * the app itself owns). `null` (global scope) is always allowed.
 */
function pieceExists(db: ReturnType<typeof getDb>, pieceId: string | null): boolean {
  if (pieceId === null) return true;
  const [row] = db
    .select({ id: pieces.id })
    .from(pieces)
    .where(eq(pieces.id, pieceId))
    .limit(1)
    .all();
  return row != null;
}

/** Save a base64-encoded asset (audio, image, etc.) as a file on the piece. */
export async function saveAsset(
  ctx: ToolContext,
  params: SaveAssetParams,
): Promise<ToolResult> {
  const { filename, name, description, type, contentType, data } = params;

  const storage = await getStorage();
  const db = getDb();

  const buffer = Buffer.from(data, "base64");
  const storagePath = await storage.save(
    ctx.pieceId,
    filename,
    buffer,
    contentType,
  );

  // Video assets get probed for audio + alpha presence now that the bytes are
  // on disk (mirrors `storeFile`). Without this, a base64-saved video lands
  // with has_alpha = NULL, which every consumer reads as OPAQUE — an alpha
  // cutout saved through this path would export as an opaque rectangle.
  let hasAudio: boolean | null = null;
  let hasAlpha: boolean | null = null;
  if (type === "video" || categorizeFileType(contentType ?? null) === "video") {
    const probed = await probeMedia(storage.localPath(ctx.pieceId, filename));
    hasAudio = probed.hasAudio ?? false;
    hasAlpha = probed.hasAlpha ?? false;
  }

  const [record] = await db
    .insert(files)
    .values({
      pieceId: ctx.pieceId,
      filename,
      name,
      description,
      type,
      storagePath,
      contentType: contentType ?? null,
      size: buffer.byteLength,
      hasAudio,
      hasAlpha,
    })
    .returning();

  return {
    success: true,
    data: {
      fileId: record.id,
      filename,
      name,
      description,
      type,
      storagePath,
    },
  };
}

function matchesQuery(f: FileRecord, query: string | undefined): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return f.name.toLowerCase().includes(q) || f.filename.toLowerCase().includes(q) || (f.description?.toLowerCase().includes(q) ?? false);
}

/** A file as the grouped (several-pieces) listing prints it: what picking one needs, nothing a loop of pieces repeats. */
function compactFile(f: FileRecord) {
  const rights = effectiveRights(f);
  return {
    id: f.id,
    name: f.name,
    filename: f.filename,
    type: f.type,
    ...(f.mediaDuration != null ? { mediaDuration: f.mediaDuration } : {}),
    ...(f.mediaWidth != null && f.mediaHeight != null ? { mediaWidth: f.mediaWidth, mediaHeight: f.mediaHeight } : {}),
    ...(f.hasAudio != null ? { hasAudio: f.hasAudio } : {}),
    ...(rights ? { rights: rights.class, ...(rights.track?.title ? { track: rights.track.title } : {}) } : {}),
  };
}

/**
 * `libi.list_files` over several pieces (`pieceIds` / `pieceFolderId`): ONE call, grouped by piece, compact rows. With a
 * `query` that finds exactly one file in every piece it adds `perPiece` ({ pieceId: { fileId } }, what an
 * `libi.apply_ops` op takes), so "the song already in each copy" is one call and one paste, not a list per piece.
 */
function listFilesForPieces(pieceList: TargetPiece[], query: string | undefined): ToolResult {
  const db = getDb();
  const rows = db.select().from(files).where(inArray(files.pieceId, pieceList.map((p) => p.id))).orderBy(desc(files.createdAt)).all();
  const byPiece = new Map<string, FileRecord[]>();
  for (const f of rows) {
    if (!f.pieceId || !matchesQuery(f, query)) continue;
    byPiece.set(f.pieceId, [...(byPiece.get(f.pieceId) ?? []), f]);
  }
  const groups = pieceList.map((p) => ({ pieceId: p.id, name: p.name, files: (byPiece.get(p.id) ?? []).map(compactFile) }));
  const data: Record<string, unknown> = { pieces: groups };
  if (query) {
    const notOne = groups.filter((g) => g.files.length !== 1);
    if (notOne.length === 0) {
      data.perPiece = Object.fromEntries(groups.map((g) => [g.pieceId, { fileId: g.files[0].id }]));
    } else {
      data.note = `No perPiece: ${notOne.map((g) => `${g.name || g.pieceId} has ${g.files.length}`).join(", ")} match "${query}". Narrow \`query\` until each piece has exactly one.`;
    }
  }
  return { success: true, data };
}

export async function listFiles(
  ctx: ToolContext,
  params: ListFilesParams,
): Promise<ToolResult> {
  const db = getDb();
  const scope = params.scope ?? "piece";

  if (params.pieceIds !== undefined || params.pieceFolderId !== undefined) {
    if (params.scope !== undefined && params.scope !== "piece") return { success: false, error: "pieceIds / pieceFolderId list piece files: leave scope out (or 'piece')." };
    const targets = resolveManyPieces(params, { max: LIST_FILES_MAX_PIECES });
    if (!targets.ok) return { success: false, error: targets.error };
    return listFilesForPieces(targets.pieces, params.query);
  }
  if (params.recursive !== undefined) return { success: false, error: "recursive only goes with pieceFolderId." };

  let result: FileRecord[];

  if (scope === "all") {
    result = db.select().from(files).orderBy(desc(files.createdAt)).all();
  } else if (scope === "global") {
    result = db.select().from(files).where(isNull(files.pieceId)).orderBy(desc(files.createdAt)).all();
  } else {
    // scope === "piece"
    const pieceId = params.pieceId ?? ctx.pieceId;
    if (!pieceId) {
      return { success: false, error: "pieceId is required when scope is 'piece' (or name pieceIds / pieceFolderId for several pieces in one call)" };
    }
    result = db.select().from(files).where(eq(files.pieceId, pieceId)).orderBy(desc(files.createdAt)).all();
  }

  result = result.filter((f) => matchesQuery(f, params.query));

  return {
    success: true,
    data: { files: result },
  };
}

/** Resolve a file id to its on-disk absolute path. Returns null if no
 *  row exists for the id. Used by music-analysis tools to pass a real
 *  path to the librosa subprocess. */
export async function getFileLocalPath(fileId: string): Promise<string | null> {
  const db = getDb();
  const [row] = db.select().from(files).where(eq(files.id, fileId)).all();
  if (!row) return null;
  const storage = await getStorage();
  return storage.localPath(row.pieceId, row.filename);
}

const DUPLICATE_TARGETS_MESSAGE = "name exactly one of targetPieceId, targetPieceIds, targetPieceFolderId.";

type FileRow = typeof files.$inferSelect;

/** Copy `source`'s bytes into `targetPieceId` (null = global) under a name free there, same rights and provenance. */
async function copyFileInto(
  db: ReturnType<typeof getDb>,
  source: FileRow,
  buffer: Buffer,
  targetPieceId: string | null,
  name: string | undefined,
): Promise<FileRecord> {
  // Generate a unique filename to avoid overwriting existing files at the target
  let targetFilename = source.filename;
  const existingFiles = db
    .select()
    .from(files)
    .where(targetPieceId ? eq(files.pieceId, targetPieceId) : isNull(files.pieceId))
    .all();
  const existingNames = new Set(existingFiles.map((f) => f.filename));

  if (existingNames.has(targetFilename)) {
    const ext = path.extname(targetFilename);
    const base = path.basename(targetFilename, ext);
    let counter = 1;
    while (existingNames.has(`${base} (${counter})${ext}`)) {
      counter++;
    }
    targetFilename = `${base} (${counter})${ext}`;
  }

  // Store as a new file in the target location
  return storeFile({
    pieceId: targetPieceId,
    filename: targetFilename,
    buffer,
    contentType: source.contentType,
    name: name ?? source.name,
    description: source.description,
    mediaDuration: source.mediaDuration ?? undefined,
    mediaWidth: source.mediaWidth ?? undefined,
    mediaHeight: source.mediaHeight ?? undefined,
    hasAudio: source.hasAudio ?? undefined,
    hasAlpha: source.hasAlpha ?? undefined,
    // A copy is the same media: same rights, same provenance. An unstamped
    // source stays unstamped and reads the same through the copied
    // aiGeneration/description (generated, a legacy download, or owned).
    aiGeneration: parseAiGenerationMeta(source.aiGeneration),
    audioRights: parseAudioRights(source.audioRights),
  });
}

/**
 * `libi.duplicate_file`. With `targetPieceId` (a piece, or null for global) it copies the file there and answers
 * with the copy, as it always has. With `targetPieceIds` or `targetPieceFolderId` it copies it into EACH piece in
 * this one call (the bytes read once, each piece getting its own row and bytes, the source's rights and provenance
 * on every copy) and answers `{ files: [{ pieceId, fileId }], perPiece }` like `upload_file`'s multi-piece form:
 * `perPiece` goes straight into an `libi.apply_ops` op. A target that is the source's own piece is not copied; it
 * keeps the source, and `perPiece` names it so a fan-out over every piece still has a file for each.
 */
export async function duplicateFile(params: DuplicateFileParams): Promise<ToolResult> {
  const { fileId, targetPieceId, targetPieceIds, targetPieceFolderId, recursive, name } = params;
  const db = getDb();
  const storage = await getStorage();

  const named = [targetPieceId !== undefined, targetPieceIds !== undefined, targetPieceFolderId !== undefined].filter(Boolean).length;
  if (named !== 1) return { success: false, error: `${named > 1 ? "Mixed targets: " : "No target: "}${DUPLICATE_TARGETS_MESSAGE}` };
  if (recursive !== undefined && targetPieceFolderId === undefined) return { success: false, error: "recursive only goes with targetPieceFolderId." };

  const [source] = db
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1)
    .all();

  if (!source) {
    return { success: false, error: `File not found: ${fileId}` };
  }

  if (targetPieceId !== undefined) {
    // RC-D: never duplicate into a non-existent (or traversal-shaped) target piece.
    if (!pieceExists(db, targetPieceId)) {
      return { success: false, error: `Piece not found: ${targetPieceId}` };
    }
    const buffer = await storage.read(source.pieceId, source.filename);
    const record = await copyFileInto(db, source, buffer, targetPieceId, name);
    return {
      success: true,
      data: {
        fileId: record.id,
        filename: record.filename,
        name: record.name,
        pieceId: record.pieceId,
        sourceFileId: source.id,
      },
    };
  }

  // Resolve the targets BEFORE copying anything: an unknown piece refuses the whole call.
  let targets: TargetPiece[];
  if (targetPieceFolderId !== undefined) {
    const found = piecesInFolder(targetPieceFolderId, recursive);
    if ("missing" in found) return { success: false, error: `targetPieceFolderId: no folder ${targetPieceFolderId} (libi.piece_folder action list shows the ids).` };
    if ("empty" in found) return { success: false, error: `targetPieceFolderId: folder ${targetPieceFolderId} holds no pieces${recursive ? "" : " (pass recursive: true to include its subfolders)"}.` };
    targets = found.pieces;
  } else {
    const found = piecesByIds(targetPieceIds ?? []);
    if (found.unknown.length > 0) {
      return { success: false, error: `targetPieceIds: no such piece ${found.unknown.join(", ")}. Nothing was copied (libi.list_pieces shows the ids).` };
    }
    targets = found.pieces;
  }
  if (targets.length === 0) return { success: false, error: "targetPieceIds is empty." };
  if (targets.length > UPLOAD_MAX_PIECES) {
    return { success: false, error: `That names ${targets.length} pieces; the limit is ${UPLOAD_MAX_PIECES} per call. Split it across calls.` };
  }

  const toCopy = targets.filter((t) => t.id !== source.pieceId);
  const buffer = toCopy.length > 0 ? await storage.read(source.pieceId, source.filename) : Buffer.alloc(0);
  const stored: { pieceId: string; fileId: string }[] = [];
  const errors: { pieceId: string; error: string }[] = [];
  for (const piece of toCopy) {
    try {
      const record = await copyFileInto(db, source, buffer, piece.id, name);
      stored.push({ pieceId: piece.id, fileId: record.id });
    } catch (err) {
      errors.push({ pieceId: piece.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const ownPiece = targets.some((t) => t.id === source.pieceId) && source.pieceId !== null;
  if (stored.length === 0 && !ownPiece) {
    return { success: false, error: `Nothing was copied: ${errors.map((e) => `${e.pieceId}: ${e.error}`).join("; ")}` };
  }
  return {
    success: true,
    data: {
      files: stored,
      // Straight into an apply_ops op: each piece applies its own file (the source's piece, the source itself).
      perPiece: {
        ...(ownPiece ? { [source.pieceId as string]: { fileId: source.id } } : {}),
        ...Object.fromEntries(stored.map((f) => [f.pieceId, { fileId: f.fileId }])),
      },
      sourceFileId: source.id,
      ...(ownPiece ? { note: "The source's own piece was not copied into: it keeps the source file (perPiece names it)." } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

/**
 * Extensions worth trusting when the client's MIME type tells us nothing.
 *
 * Deliberately a short list of what libi actually works with, not an
 * exhaustive mime database: a wrong guess here mislabels a user's file, and
 * "other" is a safe, honest answer for anything not named.
 */
const EXTENSION_CATEGORIES: Record<string, string> = {
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video", m4v: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio", opus: "audio",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", heic: "image", avif: "image",
  pdf: "document", txt: "document", md: "document", json: "document", csv: "document", srt: "document", vtt: "document",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
};

/**
 * A content type that carries no information. `application/octet-stream` is
 * what curl, `fetch` with a Blob, and most scripts send when nobody set one —
 * it means "bytes", not "unknown binary format we should respect".
 */
function isUninformative(contentType: string | null): boolean {
  if (!contentType) return true;
  const t = contentType.split(";")[0].trim().toLowerCase();
  return t === "" || t === "application/octet-stream" || t === "binary/octet-stream";
}

/**
 * Maps a file to a general category.
 *
 * The client's MIME type is the PRIMARY signal and is never second-guessed:
 * a file the caller labelled correctly keeps exactly the category it had
 * before this function learned about filenames. That is the regression this
 * most needs to not have.
 *
 * The filename is a FALLBACK, consulted only when the content type carries no
 * information. Found on 2026-08-21: a direct `POST /api/upload` with no
 * content type — curl's default is `application/octet-stream` — landed a 3s
 * `.m4a` as `type: "other"`, which then meant nothing probed it either,
 * because the ffprobe gate keys off the category. The UI path was never
 * affected; it sets a real type in the browser.
 */
export function categorizeFileType(
  contentType: string | null,
  filename?: string | null,
): string {
  if (isUninformative(contentType)) {
    const ext = filename?.split(".").pop()?.toLowerCase();
    if (ext && ext !== filename?.toLowerCase()) {
      const guess = EXTENSION_CATEGORIES[ext];
      if (guess) return guess;
    }
    return "other";
  }
  if (!contentType) return "other";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/")) return "document";
  if (contentType === "application/pdf" || contentType === "application/json") {
    return "document";
  }
  if (
    contentType.startsWith("font/") ||
    contentType === "application/font-sfnt" ||
    contentType === "application/x-font-ttf" ||
    contentType === "application/vnd.ms-opentype"
  ) {
    return "font";
  }
  return "other";
}

/** The categories `categorizeFileType` can answer besides `other`. */
const KNOWN_FILE_CATEGORIES: ReadonlySet<string> = new Set(["image", "video", "audio", "document", "font"]);

/** "an" before a vowel-initial category word ("an audio", "an image"), "a" otherwise. */
export function articleFor(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/**
 * A stored file's category, for the kind gates (an overlay's `fileId`, a
 * template slot's value). `files.type` is trusted only when it IS one of the
 * known categories: `libi.save_asset` stores the agent's free-text type
 * verbatim (`image/png`, `audio/voiceover`), and a row written before
 * extension inference existed says `other` for a real image or video. Anything
 * else is re-derived from the content type and filename. `other` means still
 * unknown, which a gate must let through.
 */
export function fileCategoryOf(file: {
  type: string | null;
  contentType: string | null;
  filename: string | null;
}): string {
  if (file.type && KNOWN_FILE_CATEGORIES.has(file.type)) return file.type;
  return categorizeFileType(file.contentType, file.filename);
}

export interface StoreFileParams {
  pieceId: string | null;
  filename: string;
  buffer: Buffer;
  contentType: string | null;
  name?: string;
  description?: string;
  mediaDuration?: number;
  mediaWidth?: number;
  mediaHeight?: number;
  hasAudio?: boolean;
  /** True iff the video carries an alpha channel. Pre-probed callers pass it;
   *  otherwise `storeFile` probes for videos. Alpha-bearing video never gets
   *  a proxy (H.264 yuv420p would silently strip the alpha plane). */
  hasAlpha?: boolean;
  /** AI-generation provenance — set by MCP generation tools (fal-ai,
   *  elevenlabs, local-tts, local-music, etc.). In test mode fake-fal
   *  masquerades as fal-ai. Surfaced in the Asset Preview Panel's "Generation"
   *  tab. See lib/ai-generation/types.ts. */
  aiGeneration?: import("@/lib/ai-generation/types").AiGenerationMeta | null;
  /** Audio rights stamp (spec §4.2). Written only when the stored file carries
   *  audio. Omitted: a file with `aiGeneration` is stamped `generated`; any
   *  other file stays NULL, which `effectiveRights` reads by provenance (a
   *  `Downloaded from` breadcrumb → copyrighted, else owned). Upload paths
   *  pass `uploadedStamp()` explicitly. */
  audioRights?: AudioRights | null;
  /** Place the new file inside this asset folder. Must match the file's scope
   *  (piece file → that piece's folder; global file → a global folder). */
  folderId?: string | null;
  /** Suppress the automatic `proxy_gen` enqueue below. For assets that are
   *  WATCHED IMMEDIATELY, where a mid-playback source swap costs more than
   *  scrub density: when a proxy finishes, the runner emits `refresh_query`,
   *  `buildComposition` re-runs and `pickVideoUrl` starts returning the proxy,
   *  so every overlay on that file changes `videoUrl` — plausibly while the
   *  user is watching. A ≤1080p source gains nothing from a proxy but denser
   *  GOPs for scrubbing, which a piece that is played rather than scrubbed
   *  never spends. Leave it unset for ordinary uploads and agent imports. */
  skipProxyGeneration?: boolean;
}

/**
 * Return a filename unique within the given scope (a piece's directory, or
 * `_global/`). If `filename` already exists, append " (N)" before the
 * extension — the same scheme `duplicateFile` uses — so two same-named saves
 * never share one physical path.
 */
function dedupeFilename(
  db: ReturnType<typeof getDb>,
  pieceId: string | null,
  filename: string,
): string {
  const existing = db
    .select({ filename: files.filename })
    .from(files)
    .where(pieceId ? eq(files.pieceId, pieceId) : isNull(files.pieceId))
    .all();
  const taken = new Set(existing.map((f) => f.filename));
  if (!taken.has(filename)) return filename;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let counter = 1;
  while (taken.has(`${base} (${counter})${ext}`)) counter++;
  return `${base} (${counter})${ext}`;
}

/**
 * Saves a file to storage and inserts a record into the files table.
 * Returns the inserted FileRecord.
 */
export async function storeFile(params: StoreFileParams): Promise<FileRecord> {
  const {
    pieceId,
    buffer,
    contentType,
    name,
    description,
    mediaDuration,
    mediaWidth,
    mediaHeight,
    hasAudio,
  } = params;

  // Strip directory traversal attempts
  const baseSanitized = path.basename(params.filename);

  const storage = await getStorage();
  const db = getDb();

  // RC-D: refuse to write into a directory for a piece that doesn't exist.
  // storeFile is the shared chokepoint (upload_file, saveAsset, duplicateFile,
  // UI upload route) and returns a FileRecord, so it signals failure by
  // throwing — consistent with its existing failure modes (storage.save throw).
  if (!pieceExists(db, pieceId)) {
    throw new Error(`Piece not found: ${pieceId}`);
  }

  // Dedupe the filename within the same scope (piece files share a directory;
  // global files share `_global/`). Without this, two uploads of the same name
  // collide on one physical path: both DB rows point at one file, and deleting
  // either unlinks the shared bytes and orphans the survivor. Mirror the
  // `duplicateFile` suffix scheme (" (N)") so saved bytes always stand alone.
  const sanitizedFilename = dedupeFilename(db, pieceId, baseSanitized);

  const storagePath = await storage.save(
    pieceId,
    sanitizedFilename,
    buffer,
    contentType ?? undefined,
  );

  // For media the caller didn't pre-probe (UI uploads via the
  // `/api/(pieces/:id/)upload` routes, and anything posting to those routes
  // directly), run ffprobe now that the bytes are on disk. Without this,
  // every UI-uploaded video lands with hasAudio=false because the
  // browser-side `probeMediaMetadata` doesn't expose audio-track presence —
  // which then misleads the agent.
  // Alpha presence is probed under the same roof: an alpha-bearing video
  // (matte_gen cutout, fal transparent WebM) must land with hasAlpha=true so
  // the proxy pipeline skips it and pickVideoUrl never serves a proxy for it.
  //
  // AUDIO is probed too, and used not to be. The gate read "video only", so
  // an audio file that arrived without client-side metadata landed with
  // mediaDuration=null AND hasAudio=false — the second one an outright lie
  // about an audio file, and exactly the misleading-the-agent case the
  // paragraph above exists to prevent. Reproduced with a 3s .m4a posted to
  // /api/upload with a correct audio/mp4 content type: both fields wrong,
  // and the transcription pipeline then refuses the file.
  let resolvedHasAudio = hasAudio;
  let resolvedHasAlpha = params.hasAlpha;
  let resolvedDuration = mediaDuration;
  let resolvedWidth = mediaWidth;
  let resolvedHeight = mediaHeight;
  let probedVideoCodec: string | undefined;
  let probedMedia: Awaited<ReturnType<typeof probeMedia>> | undefined;
  const category = categorizeFileType(contentType, sanitizedFilename);
  const needsProbe =
    category === "video"
      ? resolvedHasAudio === undefined || resolvedHasAlpha === undefined
      : category === "audio"
        ? resolvedHasAudio === undefined || resolvedDuration === undefined
        : false;
  if (needsProbe) {
    const probed = await probeMedia(storage.localPath(pieceId, sanitizedFilename));
    probedMedia = probed;
    resolvedHasAudio ??= probed.hasAudio;
    resolvedHasAlpha ??= probed.hasAlpha;
    resolvedDuration ??= probed.duration;
    resolvedWidth ??= probed.width;
    resolvedHeight ??= probed.height;
    probedVideoCodec = probed.videoCodec;
  }

  // Serialize AI-generation provenance for the new column. Skipped when the
  // caller didn't pass one (regular uploads / trims / concats stay null).
  const { serializeAiGenerationMeta } = await import("@/lib/ai-generation/types");
  const aiGenerationRaw = serializeAiGenerationMeta(params.aiGeneration);

  // Rights are written only for audio-bearing files (spec §4.2): an explicit
  // caller stamp wins, a generation-tool file with audio is `generated`, and
  // anything else stays NULL — read by provenance (`effectiveRights`).
  const carriesAudio = fileCarriesAudio({ type: category, hasAudio: resolvedHasAudio ?? false, audioRights: null });
  const audioRightsRaw = carriesAudio
    ? serializeAudioRights(params.audioRights ?? (params.aiGeneration ? generatedStamp(params.aiGeneration.prompt) : null))
    : null;

  const [record] = await db
    .insert(files)
    .values({
      pieceId,
      filename: sanitizedFilename,
      name: name ?? sanitizedFilename,
      description: description ?? "",
      type: category,
      storagePath,
      contentType: contentType ?? null,
      size: buffer.byteLength,
      mediaDuration: resolvedDuration ?? null,
      mediaWidth: resolvedWidth ?? null,
      mediaHeight: resolvedHeight ?? null,
      hasAudio: resolvedHasAudio ?? false,
      hasAlpha: resolvedHasAlpha ?? false,
      aiGeneration: aiGenerationRaw,
      audioRights: audioRightsRaw,
    })
    .returning();

  // Place the file in a folder when requested (scope-validated). Files
  // otherwise land at the root of their scope (folderId stays null).
  if (params.folderId) {
    const { moveAsset } = await import("@/lib/asset-folders/lifecycle");
    await moveAsset(record.id, params.folderId); // throws scope_mismatch if invalid
    record.folderId = params.folderId;
  }

  // VPx-alpha video NEVER gets a proxy: the H.264 yuv420p proxy strips the
  // alpha plane, and alphamerge keeps the original RGB planes intact, so an
  // alpha-stripped cutout proxy IS the original video, background and all.
  // (The proxy_gen runner refuses such rows too — this skip keeps the jobs
  // table clean on the primary path.) Non-VPx alpha (ProRes 4444, qtrle, ...)
  // DOES enqueue: preview generally can't decode that original at all, so the
  // opaque scrub proxy is strictly better than no preview — and exports read
  // the ORIGINAL regardless. When no probe ran (caller pre-supplied both
  // hasAudio + hasAlpha, e.g. matte_gen's VP9-alpha cutout), the helper falls
  // back to the WebM container signal.
  if (
    record.type === "video" &&
    !params.skipProxyGeneration &&
    !alphaRecoverableInPreview({
      hasAlpha: record.hasAlpha,
      videoCodec: probedVideoCodec,
      filename: record.filename,
      contentType: record.contentType,
    })
  ) {
    void enqueueJobOnServer(
      "proxy_gen",
      { fileId: record.id },
      { pieceId: record.pieceId, fileId: record.id },
    ).catch((err) => logProxyGenEnqueueFailure(record.id, err));
  }

  // An audio file the preview can't play itself (a chained Ogg, FLAC in Ogg,
  // a codec WebCodecs doesn't decode, HE-AAC on a mono core) gets an AAC
  // proxy, which the preview's audio engine plays instead
  // (lib/ffmpeg/audio-preview.ts, review round 4). (An MP3 or FLAC file holds
  // only its own codec, which the preview plays: no probe for those.)
  if (record.type === "audio" && !params.skipProxyGeneration && mayNeedAudioPreviewProxy(sanitizedFilename)) {
    const localPath = storage.localPath(pieceId, sanitizedFilename);
    // An undecided check (a probe that timed out) still makes the proxy: a
    // spare one costs a transcode, a missing one is a silent preview (review I2).
    const verdict = await audioProxyVerdict(localPath, probedMedia ?? (await probeMedia(localPath)));
    if (verdict.reason || verdict.unknown) {
      void enqueueJobOnServer(
        "proxy_gen",
        { fileId: record.id },
        { pieceId: record.pieceId, fileId: record.id },
      ).catch((err) => logProxyGenEnqueueFailure(record.id, err));
    }
  }

  return record;
}

const EXTENSION_MIME_MAP: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
};

/** Returns the MIME type for a filename based on its extension, or null if unknown. */
export function mimeFromExtension(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? null;
}

/** @internal — re-export for back-compat with existing tests. */
export const __probeMediaForTests = probeMedia;

export interface AssignFileParams {
  fileId: string;
  pieceId: string | null;
}

export async function assignFile(params: AssignFileParams): Promise<ToolResult> {
  const { fileId, pieceId: targetPieceId } = params;
  const db = getDb();
  const storage = await getStorage();

  const [file] = db
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1)
    .all();

  if (!file) {
    return { success: false, error: `File not found: ${fileId}` };
  }

  // RC-D: never assign (write bytes) into a non-existent (or traversal-shaped)
  // target piece.
  if (!pieceExists(db, targetPieceId)) {
    return { success: false, error: `Piece not found: ${targetPieceId}` };
  }

  const currentPieceId = file.pieceId;

  // No-op if already in the target location
  if (currentPieceId === targetPieceId) {
    return {
      success: true,
      data: { fileId: file.id, pieceId: targetPieceId, message: "File already assigned to this piece" },
    };
  }

  // Dedupe the filename within the DESTINATION scope before writing a single
  // byte. `storage.save` ends in `fs.rename`, which replaces unconditionally
  // — without this, assigning a file into a piece that already holds one
  // with the same name overwrites its bytes on disk while its DB row keeps
  // pointing at the (now shared) filename. Deleting either row then unlinks
  // the shared bytes and orphans the survivor: the exact `storeFile` bug
  // this mirrors (see the comment on `dedupeFilename`), reachable here too
  // now that `assign_file` is registered and every chat/terminal attachment
  // routes through it.
  const targetFilename = dedupeFilename(db, targetPieceId, file.filename);

  // Move the file on disk: read from old location, save to new (deduped) name.
  const newStoragePath = await storage.save(
    targetPieceId,
    targetFilename,
    await storage.read(currentPieceId, file.filename),
  );

  // The proxy, filmstrip and analysis folder live in the scope folder too, and
  // every reader finds them through the row's pieceId: they move with the
  // bytes or are dropped, never left behind under a row that says "ready".
  const derived = moveDerivedArtifacts(file, targetPieceId, targetFilename);

  // Update DB record: new piece, new filename, new storage path. Asset
  // folders are scope-specific, so the old folder belongs to the old scope —
  // clear folderId so the file lands at the destination scope's root. The
  // filename MUST be updated to the deduped name — a row still pointing at
  // the name that was never actually written is the same data-loss bug in a
  // different place.
  db.update(files)
    .set({ pieceId: targetPieceId, filename: targetFilename, storagePath: newStoragePath, folderId: null, ...derived })
    .where(eq(files.id, fileId))
    .run();

  // Delete old file from storage (best-effort)
  try {
    await storage.delete(currentPieceId, file.filename);
  } catch {
    // Old file may already be gone
  }

  // Notify UI to refresh files + asset folders for both old and new scopes.
  if (currentPieceId) {
    navigationEmitter.emit("refresh_query", { queryKey: "files", pieceId: currentPieceId });
    navigationEmitter.emit("refresh_query", { queryKey: "asset-folders", pieceId: currentPieceId });
  }
  if (targetPieceId) {
    navigationEmitter.emit("refresh_query", { queryKey: "files", pieceId: targetPieceId });
    navigationEmitter.emit("refresh_query", { queryKey: "asset-folders", pieceId: targetPieceId });
  }

  return {
    success: true,
    data: {
      fileId: file.id,
      filename: targetFilename,
      previousPieceId: currentPieceId,
      pieceId: targetPieceId,
    },
  };
}

/** What one upload reads off the user's disk and decides ONCE, however many pieces it then goes into. */
interface PreparedUpload {
  buffer: Buffer;
  filename: string;
  contentType: string | null;
  media: Awaited<ReturnType<typeof probeMedia>>;
  /** The source's rights when `derivedFromFileId` named one. */
  inherited: AudioRights | null;
  /** `undefined` leaves the stamp to storeFile (an `aiGeneration` upload is `generated`). */
  audioRights: AudioRights | undefined;
}

/**
 * Read, probe and decide the rights of `params.filePath`, or say why not. Nothing is stored here: every refusal
 * (a missing file, a `derivedFromFileId` that is not a libi file) happens before the first byte lands anywhere.
 */
async function prepareUpload(params: UploadFileParams): Promise<{ error: string } | PreparedUpload> {
  const { filePath, aiGeneration, derivedFromFileId } = params;

  try {
    await fs.access(filePath);
  } catch {
    return { error: `File not found: ${filePath}` };
  }

  // A file made from another libi file inherits that file's audio rights
  // (`derivedRights`: the most restrictive of its inputs, read through
  // `effectiveRights`). The agent may say "derived"; it can never say "owned" —
  // the class comes from the source, not from the call. Checked before any
  // byte is stored: a source that is not a libi file is refused, not guessed.
  let inherited: AudioRights | null = null;
  if (derivedFromFileId !== undefined) {
    const [source] = getDb()
      .select({
        type: files.type,
        hasAudio: files.hasAudio,
        audioRights: files.audioRights,
        createdAt: files.createdAt,
        aiGeneration: files.aiGeneration,
        description: files.description,
      })
      .from(files)
      .where(eq(files.id, derivedFromFileId))
      .limit(1)
      .all();
    if (!source) {
      return { error: `derivedFromFileId ${derivedFromFileId} is not a libi file. Pass the id of the file this one was made from (libi.list_files), or omit it for a plain upload.` };
    }
    inherited = derivedRights([source]);
  }

  const buffer = Buffer.from(await fs.readFile(filePath));
  const filename = path.basename(filePath);
  return {
    buffer,
    filename,
    contentType: mimeFromExtension(filename),
    media: await probeMedia(filePath),
    inherited,
    // A file from the user's disk is theirs (owner decision 2026-09-28); one
    // that carries `aiGeneration` is left to storeFile, which stamps it
    // generated. An agent that uploads a file it fetched from the web itself
    // stamps it copyrighted (`libi.set_audio_rights`, social-music skill §1).
    // A derived file takes its source's rights — and a copyrighted source wins
    // over `aiGeneration` (an AI remix of a released song is still that song's).
    // Otherwise as before: aiGeneration → generated (left to storeFile), else owned.
    audioRights:
      inherited && (inherited.class === "copyrighted" || !aiGeneration)
        ? inherited
        : aiGeneration
          ? undefined
          : uploadedStamp(),
  };
}

/** Store a prepared upload in ONE piece: the single path every target of an upload goes through. */
function storePrepared(pieceId: string, params: UploadFileParams, prep: PreparedUpload, folderId: string | undefined): Promise<FileRecord> {
  return storeFile({
    pieceId,
    filename: prep.filename,
    buffer: prep.buffer,
    contentType: prep.contentType,
    name: params.name,
    description: params.description,
    mediaDuration: prep.media.duration,
    mediaWidth: prep.media.width,
    mediaHeight: prep.media.height,
    hasAudio: prep.media.hasAudio,
    hasAlpha: prep.media.hasAlpha,
    aiGeneration: params.aiGeneration,
    audioRights: prep.audioRights,
    folderId,
  });
}

/** The facts of a stored file that read the same for every copy of an upload. */
function uploadedFileFacts(record: FileRecord, prep: PreparedUpload, derivedFromFileId: string | undefined) {
  return {
    name: record.name,
    type: record.type,
    contentType: record.contentType,
    size: record.size,
    mediaDuration: record.mediaDuration,
    mediaWidth: record.mediaWidth,
    mediaHeight: record.mediaHeight,
    // aiGeneration is the serialized JSON string as stored, or null. The
    // agent can parse-and-display it for confirmation, or just rely on the
    // editor's Generation tab. Test fixtures assert on this shape.
    aiGeneration: record.aiGeneration ?? null,
    // Said only for a derived file with audio, so the agent sees what it inherited.
    ...(prep.inherited && fileCarriesAudio(record)
      ? { audioRights: { class: parseAudioRights(record.audioRights)?.class ?? prep.inherited.class, inheritedFrom: derivedFromFileId } }
      : {}),
  };
}

/** The most pieces one `upload_file` call stores into (the same ceiling as `libi.apply_ops`). */
export const UPLOAD_MAX_PIECES = 50;

const UPLOAD_TARGETS_MESSAGE = "name exactly one of pieceId, pieceIds, pieceFolderId.";

/**
 * `libi.upload_file`. With `pieceId` it stores the file in that piece and answers with the file record, as it
 * always has. With `pieceIds` or `pieceFolderId` it stores the file ONCE PER PIECE in this one call: each piece
 * gets its own `files` row and its own bytes (files belong to a piece), read and probed once, the same
 * provenance and rights stamped on every copy. It answers `{ files: [{ pieceId, fileId }], perPiece }` — the
 * `perPiece` map is exactly what an `libi.apply_ops` op takes to give each piece its own `fileId`.
 */
export async function uploadFile(
  ctx: ToolContext,
  params: UploadFileParams,
): Promise<ToolResult> {
  const { pieceIds, pieceFolderId, recursive, folderId, derivedFromFileId } = params;
  const named = [params.pieceId !== undefined, pieceIds !== undefined, pieceFolderId !== undefined].filter(Boolean).length;
  if (named > 1 || (named === 0 && !ctx.pieceId)) return { success: false, error: `${named > 1 ? "Mixed targets: " : "No target piece: "}${UPLOAD_TARGETS_MESSAGE}` };
  if (recursive !== undefined && pieceFolderId === undefined) return { success: false, error: "recursive only goes with pieceFolderId." };
  const many = pieceIds !== undefined || pieceFolderId !== undefined;
  if (many && folderId !== undefined) {
    return { success: false, error: "folderId is an ASSET folder inside one piece, so it does not go with pieceIds / pieceFolderId. Upload without it, then move each file with libi.asset_folder." };
  }

  if (!many) {
    const prep = await prepareUpload(params);
    if ("error" in prep) return { success: false, error: prep.error };
    const record = await storePrepared(params.pieceId ?? ctx.pieceId, params, prep, folderId);
    return {
      success: true,
      data: { fileId: record.id, filename: record.filename, ...uploadedFileFacts(record, prep, derivedFromFileId) },
    };
  }

  // Resolve the targets BEFORE storing anything: an unknown piece refuses the whole call.
  let targets: TargetPiece[];
  if (pieceFolderId !== undefined) {
    const found = piecesInFolder(pieceFolderId, recursive);
    if ("missing" in found) return { success: false, error: `pieceFolderId: no folder ${pieceFolderId} (libi.piece_folder action list shows the ids).` };
    if ("empty" in found) return { success: false, error: `pieceFolderId: folder ${pieceFolderId} holds no pieces${recursive ? "" : " (pass recursive: true to include its subfolders)"}.` };
    targets = found.pieces;
  } else {
    const found = piecesByIds(pieceIds ?? []);
    if (found.unknown.length > 0) {
      return { success: false, error: `pieceIds: no such piece ${found.unknown.join(", ")}. Nothing was uploaded (libi.list_pieces shows the ids).` };
    }
    targets = found.pieces;
  }
  if (targets.length === 0) return { success: false, error: "pieceIds is empty." };
  if (targets.length > UPLOAD_MAX_PIECES) {
    return { success: false, error: `That names ${targets.length} pieces; the limit is ${UPLOAD_MAX_PIECES} per call. Split it across calls.` };
  }

  const prep = await prepareUpload(params);
  if ("error" in prep) return { success: false, error: prep.error };

  const stored: { pieceId: string; fileId: string }[] = [];
  const errors: { pieceId: string; error: string }[] = [];
  let first: FileRecord | undefined;
  for (const piece of targets) {
    try {
      const record = await storePrepared(piece.id, params, prep, undefined);
      first ??= record;
      stored.push({ pieceId: piece.id, fileId: record.id });
    } catch (err) {
      errors.push({ pieceId: piece.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!first) return { success: false, error: `Nothing was uploaded: ${errors.map((e) => `${e.pieceId}: ${e.error}`).join("; ")}` };
  return {
    success: true,
    data: {
      files: stored,
      // Straight into an apply_ops op: each piece applies its own file.
      perPiece: Object.fromEntries(stored.map((f) => [f.pieceId, { fileId: f.fileId }])),
      filename: prep.filename,
      ...uploadedFileFacts(first, prep, derivedFromFileId),
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

export interface UpdateFileNotesParams {
  fileId: string;
  notes: string;
  mode?: "append" | "replace";
}

/** Append a timestamped line to (or replace) the agent-facing notes
 *  field on a file. Used to record lineage (prompt, model, retry index)
 *  and validation summaries that the agent needs across turns. */
export async function updateFileNotes(
  params: UpdateFileNotesParams,
): Promise<ToolResult> {
  const db = getDb();
  const [file] = db
    .select()
    .from(files)
    .where(eq(files.id, params.fileId))
    .limit(1)
    .all();
  if (!file) return { success: false, error: `File not found: ${params.fileId}` };

  const mode = params.mode ?? "append";
  let next: string;
  if (mode === "replace") {
    next = params.notes;
  } else {
    const ts = new Date().toISOString();
    const entry = `${ts} | ${params.notes}\n`;
    next = (file.notes ?? "") + entry;
  }

  db.update(files).set({ notes: next }).where(eq(files.id, params.fileId)).run();
  const [updated] = db
    .select()
    .from(files)
    .where(eq(files.id, params.fileId))
    .limit(1)
    .all();
  return { success: true, data: updated as unknown as Record<string, unknown> };
}

/** File listing and storage tool implementations */

import path from "path";
import * as fs from "fs/promises";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { alphaRecoverableInPreview } from "@/lib/ffmpeg/alpha";
import { getStorage } from "@/lib/storage";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema";
import { enqueueJobOnServer, logProxyGenEnqueueFailure } from "@/mcp/jobs-client";
import { eq, isNull, desc } from "drizzle-orm";
import { navigationEmitter } from "@/lib/navigation-events";
import type { ToolContext, ToolResult } from "./types";
import type { ListFilesParams, DuplicateFileParams, UploadFileParams, UploadFileToFalParams, SaveAssetParams } from "./schemas";
import { getCurrentPort } from "@/lib/libi-home";
import type { FileRecord } from "@/lib/db/schema/types";

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

export async function listFiles(
  ctx: ToolContext,
  params: ListFilesParams,
): Promise<ToolResult> {
  const db = getDb();
  const scope = params.scope ?? "piece";

  let result: FileRecord[];

  if (scope === "all") {
    result = db.select().from(files).orderBy(desc(files.createdAt)).all();
  } else if (scope === "global") {
    result = db.select().from(files).where(isNull(files.pieceId)).orderBy(desc(files.createdAt)).all();
  } else {
    // scope === "piece"
    const pieceId = params.pieceId ?? ctx.pieceId;
    if (!pieceId) {
      return { success: false, error: "pieceId is required when scope is 'piece'" };
    }
    result = db.select().from(files).where(eq(files.pieceId, pieceId)).orderBy(desc(files.createdAt)).all();
  }

  if (params.query) {
    const q = params.query.toLowerCase();
    result = result.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.filename.toLowerCase().includes(q) ||
        (f.description?.toLowerCase().includes(q) ?? false),
    );
  }

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

export async function duplicateFile(params: DuplicateFileParams): Promise<ToolResult> {
  const { fileId, targetPieceId, name } = params;
  const db = getDb();
  const storage = await getStorage();

  const [source] = db
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1)
    .all();

  if (!source) {
    return { success: false, error: `File not found: ${fileId}` };
  }

  // RC-D: never duplicate into a non-existent (or traversal-shaped) target piece.
  if (!pieceExists(db, targetPieceId)) {
    return { success: false, error: `Piece not found: ${targetPieceId}` };
  }

  // Read the file content from storage
  const buffer = await storage.read(source.pieceId, source.filename);

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
  const record = await storeFile({
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
  });

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

/**
 * Maps a MIME content type to a general file category.
 */
export function categorizeFileType(contentType: string | null): string {
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
  const category = categorizeFileType(contentType);
  const needsProbe =
    category === "video"
      ? resolvedHasAudio === undefined || resolvedHasAlpha === undefined
      : category === "audio"
        ? resolvedHasAudio === undefined || resolvedDuration === undefined
        : false;
  if (needsProbe) {
    const probed = await probeMedia(storage.localPath(pieceId, sanitizedFilename));
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

  // Move the file on disk: read from old location, save to new
  const newStoragePath = await storage.save(
    targetPieceId,
    file.filename,
    await storage.read(currentPieceId, file.filename),
  );

  // Update DB record: new piece, new storage path. Asset folders are
  // scope-specific, so the old folder belongs to the old scope — clear
  // folderId so the file lands at the destination scope's root.
  db.update(files)
    .set({ pieceId: targetPieceId, storagePath: newStoragePath, folderId: null })
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
      filename: file.filename,
      previousPieceId: currentPieceId,
      pieceId: targetPieceId,
    },
  };
}

export async function uploadFile(
  ctx: ToolContext,
  params: UploadFileParams,
): Promise<ToolResult> {
  const { filePath, name, description, aiGeneration, folderId } = params;

  try {
    await fs.access(filePath);
  } catch {
    return { success: false, error: `File not found: ${filePath}` };
  }

  const buffer = await fs.readFile(filePath);
  const filename = path.basename(filePath);
  const contentType = mimeFromExtension(filename);

  const media = await probeMedia(filePath);

  const record = await storeFile({
    pieceId: ctx.pieceId,
    filename,
    buffer: Buffer.from(buffer),
    contentType,
    name,
    description,
    mediaDuration: media.duration,
    mediaWidth: media.width,
    mediaHeight: media.height,
    hasAudio: media.hasAudio,
    hasAlpha: media.hasAlpha,
    aiGeneration,
    folderId,
  });

  return {
    success: true,
    data: {
      fileId: record.id,
      filename: record.filename,
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

/**
 * Upload a LOCAL libi file to fal.ai storage and return a fal CDN URL.
 *
 * Runs server-side via the Next.js route `/api/files/by-id/{fileId}/fal-upload`
 * — the MCP child has an empty env and cannot resolve the FAL key, so we MUST
 * go through the server (which already resolves it). Never import
 * `lib/fal/upload-file.ts` here.
 */
export async function uploadFileToFal(
  params: UploadFileToFalParams,
): Promise<{ success: boolean; data?: { url: string; cached: boolean }; error?: string }> {
  const { fileId } = params;

  let port: number;
  try {
    port = getCurrentPort();
  } catch {
    return { success: false, error: "libi server is not running (no port file)" };
  }

  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/files/by-id/${fileId}/fal-upload`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { success: false, error: body.error ?? `fal upload failed: HTTP ${res.status}` };
    }
    const { url, cached } = (await res.json()) as { url: string; cached: boolean };
    return { success: true, data: { url, cached } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `fal upload request failed: ${message}` };
  }
}

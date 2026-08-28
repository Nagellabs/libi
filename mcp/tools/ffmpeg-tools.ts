import path from "path";
import os from "os";
import { stat as fsStat, mkdtemp, writeFile as fsWriteFile, rm as fsRm } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getStorage } from "@/lib/storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { runFfmpeg, resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { streamHasAlpha } from "@/lib/ffmpeg/alpha";
import { buildThumbnailArgs } from "@/lib/ffmpeg/thumb-args";
import type { ToolResult } from "./types";

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/* shared helpers                                                             */
/* -------------------------------------------------------------------------- */

export async function localPathForFile(fileId: string): Promise<{
  pieceId: string | null;
  filename: string;
  localPath: string;
} | null> {
  const db = getDb();
  const [row] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!row) return null;
  const storage = await getStorage();
  if (!(storage instanceof LocalFileStorage)) {
    throw new Error("ffmpeg tools require local filesystem storage");
  }
  const localPath = storage.localPath(row.pieceId, row.filename);
  return { pieceId: row.pieceId, filename: row.filename, localPath };
}

export async function insertFileRow(args: {
  pieceId: string | null;
  filename: string;
  displayName: string;
  description: string;
  type: string;
  contentType: string;
  storagePath: string;
  size: number;
  mediaDuration?: number | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  hasAudio?: boolean | null;
  /** True iff the (derived) file carries an alpha channel — probe the OUTPUT
   *  file so whatever alpha actually survived the operation is what's
   *  recorded. Leaving it unset persists NULL, which consumers read as
   *  opaque. */
  hasAlpha?: boolean | null;
}): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  db.insert(files)
    .values({
      id,
      pieceId: args.pieceId,
      filename: args.filename,
      name: args.displayName,
      description: args.description,
      type: args.type,
      storagePath: args.storagePath,
      contentType: args.contentType,
      size: args.size,
      mediaDuration: args.mediaDuration ?? null,
      mediaWidth: args.mediaWidth ?? null,
      mediaHeight: args.mediaHeight ?? null,
      hasAudio: args.hasAudio ?? null,
      hasAlpha: args.hasAlpha ?? null,
    })
    .run();
  return id;
}

export async function probeDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(resolveFfprobePath(), [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      filePath,
    ], { windowsHide: true });
    const data = JSON.parse(stdout) as { format?: { duration?: string } };
    return data.format?.duration ? parseFloat(data.format.duration) : null;
  } catch {
    return null;
  }
}

/**
 * Probe a media file for the fields we persist on files rows: duration, the
 * video stream's pixel width/height (if any), and presence of an audio stream.
 *
 * Used by trim_video, extract_audio, concat_videos and any other ffmpeg path
 * that writes a new file row — so add_overlay / preview / pickVideoUrl
 * don't reject the new row with "no duration metadata - re-upload the file"
 * (Phase 2 round-2 finding #34).
 *
 * All fields are nullable; on probe failure we persist nulls rather than
 * blocking the file insert.
 */
export async function probeMediaInfo(filePath: string): Promise<{
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  /** True when the video stream carries alpha — directly in its pix_fmt or
   *  via the WebM `alpha_mode` side-band tag (where pix_fmt lies as
   *  yuv420p). Derived rows persist this so pickVideoUrl / the export
   *  backends treat them alpha-honestly. */
  hasAlpha: boolean;
}> {
  try {
    const { stdout } = await execFileAsync(resolveFfprobePath(), [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ], { windowsHide: true });
    const data = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        pix_fmt?: string;
        tags?: Record<string, string>;
      }>;
    };
    const duration = data.format?.duration ? parseFloat(data.format.duration) : null;
    const videoStream = data.streams?.find((s) => s.codec_type === "video");
    const hasAudio = (data.streams ?? []).some((s) => s.codec_type === "audio");
    return {
      duration,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      hasAudio,
      hasAlpha: videoStream ? streamHasAlpha(videoStream) : false,
    };
  } catch {
    return { duration: null, width: null, height: null, hasAudio: false, hasAlpha: false };
  }
}

/* -------------------------------------------------------------------------- */
/* trimVideo                                                                  */
/* -------------------------------------------------------------------------- */

export interface TrimVideoParams {
  pieceId: string;
  fileId: string;
  startSeconds: number;
  endSeconds: number;
  outputName?: string;
}

export async function trimVideo(params: TrimVideoParams): Promise<ToolResult> {
  if (params.endSeconds <= params.startSeconds) {
    return {
      success: false,
      error: "endSeconds must be greater than startSeconds",
    };
  }

  const src = await localPathForFile(params.fileId);
  if (!src) return { success: false, error: "File not found" };

  const storage = await getStorage();
  if (!(storage instanceof LocalFileStorage)) {
    return { success: false, error: "Local filesystem storage required" };
  }

  const baseName = path.parse(src.filename).name;
  const outFilename = params.outputName ?? `${baseName}-trim.mp4`;
  const outPath = storage.localPath(params.pieceId, outFilename);

  // Stream copy first (-c copy). ffmpeg falls back to re-encode if container rules require it.
  const duration = params.endSeconds - params.startSeconds;
  await runFfmpeg(
    [
      "-y",
      "-ss", params.startSeconds.toString(),
      "-to", params.endSeconds.toString(),
      "-i", src.localPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outPath,
    ],
    {
      op: "trim_video",
      context: { fileId: params.fileId, pieceId: params.pieceId, durationSeconds: duration },
      totalDurationSeconds: duration,
    },
  );

  const stat = await fsStat(outPath);
  // Probe + persist media metadata so add_overlay / pickVideoUrl
  // don't reject the new row with "no duration metadata - re-upload the file"
  // (Phase 2 round-2 finding #34).
  const probed = await probeMediaInfo(outPath);
  const fileId = await insertFileRow({
    pieceId: params.pieceId,
    filename: outFilename,
    displayName: outFilename,
    description: `Trimmed from ${src.filename} (${params.startSeconds}s – ${params.endSeconds}s)`,
    type: "video",
    contentType: "video/mp4",
    storagePath: `${params.pieceId}/${outFilename}`,
    size: stat.size,
    mediaDuration: probed.duration ?? duration,
    mediaWidth: probed.width,
    mediaHeight: probed.height,
    hasAudio: probed.hasAudio,
    // Probed from the OUTPUT: whatever alpha actually survived the trim is
    // what gets recorded (a -c copy to .mp4 loses the WebM alpha side-band —
    // hasAlpha honestly lands false in that case).
    hasAlpha: probed.hasAlpha,
  });

  return {
    success: true,
    data: {
      fileId,
      filename: outFilename,
      durationSeconds: probed.duration ?? duration,
      mediaWidth: probed.width,
      mediaHeight: probed.height,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* extractAudio                                                               */
/* -------------------------------------------------------------------------- */

export interface ExtractAudioParams {
  pieceId: string;
  fileId: string;
  /** Output format. Default "mp3" (fal @Audio1-safe). "wav" lossless; "copy" = stream-copy (.m4a, NOT for @Audio1). */
  format?: "mp3" | "wav" | "copy";
  /** Optional clip start offset in seconds (extract only a segment). */
  startSeconds?: number;
  /** Optional clip end offset in seconds (exclusive). Requires startSeconds. */
  endSeconds?: number;
  outputName?: string;
}

export async function extractAudio(params: ExtractAudioParams): Promise<ToolResult> {
  const src = await localPathForFile(params.fileId);
  if (!src) return { success: false, error: "File not found" };

  const storage = await getStorage();
  if (!(storage instanceof LocalFileStorage)) {
    return { success: false, error: "Local filesystem storage required" };
  }

  const { startSeconds, endSeconds } = params;
  if (endSeconds != null && startSeconds == null) {
    return { success: false, error: "endSeconds requires startSeconds" };
  }
  if (startSeconds != null && endSeconds != null && endSeconds <= startSeconds) {
    return { success: false, error: "endSeconds must be greater than startSeconds" };
  }

  // Format → (extension, ffmpeg codec args, DB content type). DEFAULT 'mp3' so a plain
  // extract is already a Seedance @Audio1-acceptable voice sample — audio_urls takes MP3/WAV
  // ONLY and an AAC/.m4a file 422s, so the safe format must be the default (the agent does NOT
  // reliably pass format). 'wav' = lossless PCM; 'copy' = stream-copy the source codec
  // (fast/lossless .m4a, NOT usable as an @Audio1 reference).
  const fmt = params.format ?? "mp3";
  const { ext, codecArgs, contentType } =
    fmt === "wav"
      ? { ext: "wav", codecArgs: ["-c:a", "pcm_s16le"], contentType: "audio/wav" }
      : fmt === "copy"
        ? { ext: "m4a", codecArgs: ["-c:a", "copy"], contentType: "audio/mp4" }
        : { ext: "mp3", codecArgs: ["-c:a", "libmp3lame", "-q:a", "2"], contentType: "audio/mpeg" };

  const baseName = path.parse(src.filename).name;
  const outFilename = params.outputName ?? `${baseName}-audio.${ext}`;
  const outPath = storage.localPath(params.pieceId, outFilename);

  // Input-side -ss (fast, accurate enough for transcode); -t = clip length when a range is given.
  const rangeArgs: string[] = [];
  if (startSeconds != null) rangeArgs.push("-ss", String(startSeconds));

  await runFfmpeg(
    [
      "-y",
      ...rangeArgs,
      "-i", src.localPath,
      ...(startSeconds != null && endSeconds != null ? ["-t", String(endSeconds - startSeconds)] : []),
      "-vn",
      ...codecArgs,
      outPath,
    ],
    { op: "extract_audio", context: { fileId: params.fileId, pieceId: params.pieceId } },
  );

  const stat = await fsStat(outPath);
  const probed = await probeMediaInfo(outPath);
  const fileId = await insertFileRow({
    pieceId: params.pieceId,
    filename: outFilename,
    displayName: outFilename,
    description: `Audio extracted from ${src.filename}`,
    type: "audio",
    contentType,
    storagePath: `${params.pieceId}/${outFilename}`,
    size: stat.size,
    mediaDuration: probed.duration,
    hasAudio: probed.hasAudio,
  });

  return { success: true, data: { fileId, filename: outFilename, durationSeconds: probed.duration } };
}

/* -------------------------------------------------------------------------- */
/* generateThumbnails                                                         */
/* -------------------------------------------------------------------------- */

export interface GenerateThumbnailsParams {
  pieceId: string;
  fileId: string;
  count: number;
}

export async function generateThumbnails(params: GenerateThumbnailsParams): Promise<ToolResult> {
  const src = await localPathForFile(params.fileId);
  if (!src) return { success: false, error: "File not found" };

  // One probe covers duration AND alpha detection. Alpha matters because a
  // thumbnail is the agent's verify-pixels surface for cutouts: natively
  // decoded, a VP9-alpha WebM yields the FULL ORIGINAL FRAME (the WebM alpha
  // side-band is skipped and alphamerge keeps the RGB planes intact), which
  // makes a CORRECT cutout look like "the feature did nothing". Alpha
  // sources decode via libvpx and composite over solid magenta instead —
  // "background replaced by magenta" is the honest rubric a JPG can carry.
  const probed = await probeMedia(src.localPath);
  const duration = probed.duration ?? null;
  if (!duration || duration <= 0) {
    return { success: false, error: "Could not determine source duration" };
  }
  const alpha = probed.hasAlpha ? { videoCodec: probed.videoCodec } : null;

  const storage = await getStorage();
  if (!(storage instanceof LocalFileStorage)) {
    return { success: false, error: "Local filesystem storage required" };
  }

  const baseName = path.parse(src.filename).name;
  const createdFileIds: string[] = [];
  const createdFilenames: string[] = [];

  for (let i = 0; i < params.count; i++) {
    const t = (duration * (i + 0.5)) / params.count; // evenly spaced, middle of each bucket
    const outFilename = `${baseName}-thumb-${String(i + 1).padStart(2, "0")}.jpg`;
    const outPath = storage.localPath(params.pieceId, outFilename);

    await runFfmpeg(buildThumbnailArgs({
      sourcePath: src.localPath,
      outPath,
      time: t,
      alpha,
    }), {
      op: "generate_thumbnail",
      context: { fileId: params.fileId, pieceId: params.pieceId, thumbIndex: i + 1, totalThumbs: params.count },
    });

    const stat = await fsStat(outPath);
    const id = await insertFileRow({
      pieceId: params.pieceId,
      filename: outFilename,
      displayName: outFilename,
      description: `Thumbnail ${i + 1}/${params.count} from ${src.filename}`,
      type: "image",
      contentType: "image/jpeg",
      storagePath: `${params.pieceId}/${outFilename}`,
      size: stat.size,
    });
    createdFileIds.push(id);
    createdFilenames.push(outFilename);
  }

  return {
    success: true,
    data: { fileIds: createdFileIds, filenames: createdFilenames, count: params.count },
  };
}

/* -------------------------------------------------------------------------- */
/* concatVideos                                                               */
/* -------------------------------------------------------------------------- */

export interface ConcatVideosParams {
  pieceId: string;
  fileIds: string[];
  outputName?: string;
}

export async function concatVideos(params: ConcatVideosParams): Promise<ToolResult> {
  if (params.fileIds.length < 2) {
    return { success: false, error: "At least two files are required" };
  }

  const storage = await getStorage();
  if (!(storage instanceof LocalFileStorage)) {
    return { success: false, error: "Local filesystem storage required" };
  }

  const resolved = await Promise.all(
    params.fileIds.map(async (id) => {
      const info = await localPathForFile(id);
      if (!info) throw new Error(`File not found: ${id}`);
      return info;
    }),
  );

  const outFilename = params.outputName ?? "concat.mp4";
  const outPath = storage.localPath(params.pieceId, outFilename);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "libi-concat-"));
  try {
    const listPath = path.join(tmpDir, "list.txt");
    const listBody = resolved
      .map((r) => `file '${r.localPath.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fsWriteFile(listPath, listBody, "utf-8");

    const baseContext = {
      pieceId: params.pieceId,
      fileCount: resolved.length,
      fileIds: params.fileIds,
    };

    // Try stream-copy first.
    try {
      await runFfmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-movflags", "+faststart",
        outPath,
      ], { op: "concat_videos_copy", context: baseContext });
    } catch {
      // Codec mismatch fallback: re-encode.
      await runFfmpeg([
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outPath,
      ], { op: "concat_videos_encode", context: baseContext });
    }

    const stat = await fsStat(outPath);
    const probed = await probeMediaInfo(outPath);
    const fileId = await insertFileRow({
      pieceId: params.pieceId,
      filename: outFilename,
      displayName: outFilename,
      description: `Concatenated from ${resolved.length} clips`,
      type: "video",
      contentType: "video/mp4",
      storagePath: `${params.pieceId}/${outFilename}`,
      size: stat.size,
      mediaDuration: probed.duration,
      mediaWidth: probed.width,
      mediaHeight: probed.height,
      hasAudio: probed.hasAudio,
      hasAlpha: probed.hasAlpha,
    });

    return {
      success: true,
      data: {
        fileId,
        filename: outFilename,
        clipCount: resolved.length,
        durationSeconds: probed.duration,
        mediaWidth: probed.width,
        mediaHeight: probed.height,
      },
    };
  } finally {
    try {
      await fsRm(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

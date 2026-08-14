import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { getLibiStorageDir } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { storeFile } from "@/mcp/tools/file-tools";
import type { FileRecord } from "@/lib/db/schema/types";

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BuildCropArgsInput {
  sourcePath: string;
  outputPath: string;
  bbox: Bbox;
  sourceWidth: number;
  sourceHeight: number;
  frameTime?: number;
}

/**
 * Build the ffmpeg argv for cropping a region from an image or a video frame.
 * For video sources, pass `frameTime` so `-ss` is placed BEFORE `-i` (fast keyframe seek).
 * The bbox is clamped to the source dimensions; if the resulting crop is smaller
 * than 4x4 px it throws.
 */
export function buildCropArgs(input: BuildCropArgsInput): string[] {
  // Analysis bboxes are NORMALIZED 0..1 (see `lib/analysis/schemas.ts`), but the
  // ffmpeg crop needs ABSOLUTE PIXELS. Auto-detect a normalized bbox — every
  // coord ≤ 1, which no real pixel bbox satisfies (a sub-pixel width/height is
  // meaningless) — and scale by the source dimensions. This lets
  // `create_character({ fromAsset: { bbox } })` accept the analysis bbox
  // directly (the common auto-catalog case) instead of flooring 0.38→0 into a
  // degenerate 0×0 crop.
  const isNormalized =
    input.bbox.x <= 1 &&
    input.bbox.y <= 1 &&
    input.bbox.w <= 1 &&
    input.bbox.h <= 1;
  const px = isNormalized
    ? {
        x: input.bbox.x * input.sourceWidth,
        y: input.bbox.y * input.sourceHeight,
        w: input.bbox.w * input.sourceWidth,
        h: input.bbox.h * input.sourceHeight,
      }
    : input.bbox;
  const x = Math.max(0, Math.floor(px.x));
  const y = Math.max(0, Math.floor(px.y));
  const maxW = input.sourceWidth - x;
  const maxH = input.sourceHeight - y;
  const w = Math.min(Math.floor(px.w), maxW);
  const h = Math.min(Math.floor(px.h), maxH);
  if (w < 4 || h < 4) {
    throw new Error(
      `bbox produces degenerate crop: ${w}x${h} (source ${input.sourceWidth}x${input.sourceHeight}, bbox ${JSON.stringify(input.bbox)})`,
    );
  }
  const args: string[] = ["-y"];
  if (input.frameTime !== undefined) {
    args.push("-ss", String(input.frameTime));
  }
  args.push("-i", input.sourcePath);
  if (input.frameTime !== undefined) {
    args.push("-frames:v", "1");
  }
  args.push("-vf", `crop=${w}:${h}:${x}:${y}`);
  args.push(input.outputPath);
  return args;
}

export interface CropAndStoreInput {
  sourceFile: FileRecord;
  bbox: Bbox;
  frameTime?: number;
  /** Base name for the output file, e.g. "jessica". Will be sanitized. */
  cropName: string;
}

/**
 * Crops a region from an image or video frame, stores the crop as a new global
 * file, and returns the new FileRecord. Caller is responsible for linking it
 * via `representativeImageFileId` or as a character/item asset.
 */
export async function cropAndStoreRepresentative(
  input: CropAndStoreInput,
): Promise<FileRecord> {
  // The actual storage path stored in files.storagePath is relative to the storage root.
  // For piece-scoped files it's "{pieceId}/{filename}"; for global files "_global/{filename}".
  const sourceAbsolute = path.isAbsolute(input.sourceFile.storagePath)
    ? input.sourceFile.storagePath
    : path.join(getLibiStorageDir(), input.sourceFile.storagePath);

  if (
    input.sourceFile.mediaWidth == null ||
    input.sourceFile.mediaHeight == null
  ) {
    throw new Error(
      `source file ${input.sourceFile.id} missing media dimensions`,
    );
  }

  const safeName = input.cropName.replace(/[^a-z0-9-]+/gi, "-");
  const tmpName = `${safeName}-${randomUUID().slice(0, 8)}.jpg`;
  const tmpPath = path.join("/tmp", tmpName);

  const args = buildCropArgs({
    sourcePath: sourceAbsolute,
    outputPath: tmpPath,
    bbox: input.bbox,
    sourceWidth: input.sourceFile.mediaWidth,
    sourceHeight: input.sourceFile.mediaHeight,
    frameTime: input.frameTime,
  });

  logger.info(
    {
      args,
      sourceFileId: input.sourceFile.id,
      bbox: input.bbox,
      frameTime: input.frameTime,
    },
    "catalog.crop_start",
  );
  await runFfmpeg(args, { op: "catalog_crop" });

  const buffer = await fs.readFile(tmpPath);
  const stored = await storeFile({
    pieceId: null, // global so it can be reused across pieces
    filename: tmpName,
    buffer,
    contentType: "image/jpeg",
    name: tmpName,
    description: `Representative image cropped for "${input.cropName}"`,
  });
  await fs.unlink(tmpPath).catch(() => {});

  logger.info(
    { fileId: stored.id, cropName: input.cropName },
    "catalog.crop_done",
  );
  return stored;
}

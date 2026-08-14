/** Custom-font upload tool implementation. */

import path from "path";
import * as fs from "fs/promises";
import { mcpLogger as logger } from "@/lib/logger";
import { cssFamilyForFontFile } from "@/lib/fonts/family";
import { storeFile } from "./file-tools";
import type { ToolResult } from "./types";
import type { UploadFontParams } from "./schemas";

/** Map a font-file extension to its MIME content type. */
const FONT_EXTENSION_MIME: Record<string, string> = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/**
 * Upload a custom font file (.ttf/.otf/.woff2/.woff) from the local filesystem
 * and return a `fontFileId` usable on text overlays. Modeled on
 * `libi.upload_file` — reads the file off disk, infers the content type from
 * the extension, and stores it via the shared `storeFile`.
 */
export async function uploadFont(params: UploadFontParams): Promise<ToolResult> {
  const { path: filePath, pieceId, name } = params;

  const ext = path.extname(filePath).toLowerCase();
  const contentType = FONT_EXTENSION_MIME[ext];
  if (!contentType) {
    return {
      success: false,
      error: "unsupported_font_type",
      data: {
        hint: `Unsupported font extension "${ext}". Supported: ${Object.keys(
          FONT_EXTENSION_MIME,
        ).join(", ")}.`,
      },
    };
  }

  try {
    await fs.access(filePath);
  } catch {
    return { success: false, error: `File not found: ${filePath}` };
  }

  const buffer = await fs.readFile(filePath);
  const filename = path.basename(filePath);

  const record = await storeFile({
    pieceId: pieceId ?? null,
    filename,
    buffer: Buffer.from(buffer),
    contentType,
    name,
  });

  const family = cssFamilyForFontFile(record.id);
  logger.info(
    { tag: "fonts", op: "upload_font", fileId: record.id, contentType, pieceId: pieceId ?? null },
    "font uploaded",
  );

  return {
    success: true,
    data: {
      fileId: record.id,
      filename: record.filename,
      family,
    },
  };
}

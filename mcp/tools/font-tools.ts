/** Custom-font upload and discovery tool implementations. */

import path from "path";
import * as fs from "fs/promises";
import { GlobalFonts } from "@napi-rs/canvas";
import { and, eq, isNull, or } from "drizzle-orm";
import { mcpLogger as logger } from "@/lib/logger";
import { cssFamilyForFontFile } from "@/lib/fonts/family";
import { BUNDLED_FONTS, BUNDLED_FONT_FAMILIES, isBundledFamily } from "@/lib/fonts/bundled";
import { ensureBundledFontsRegistered } from "@/lib/fonts/register-server";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { storeFile } from "./file-tools";
import type { ToolResult } from "./types";
import type { ListFontsParams, UploadFontParams } from "./schemas";

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

/** System fonts are 300+ entries on a typical Mac and platform-specific — a
 *  full dump burns the agent's context and tempts it into picking a face
 *  that only exists on this machine. Cap and flag instead. */
const SYSTEM_FONT_LIMIT = 40;

/**
 * Report every font family that will actually resolve on this machine, so an
 * agent can pick one instead of guessing — see `lib/fonts/bundled.ts` for the
 * silent-fallback bug this exists to prevent. Three sources:
 *
 *  - `bundled`: libi's own families, identical on every platform, always
 *    available. Prefer these.
 *  - `system`: this machine's installed fonts, capped at
 *    `SYSTEM_FONT_LIMIT` and excluding bundled families (already listed
 *    above). NOT portable — a different OS or a fresh install won't have
 *    them, so a piece that leans on one renders differently elsewhere.
 *  - `uploaded`: fonts uploaded via `libi.upload_font`, scoped to
 *    `params.pieceId` (if given) plus global uploads.
 */
export async function listFonts(params: ListFontsParams): Promise<ToolResult> {
  // A cold process hasn't registered the bundled faces with @napi-rs/canvas
  // yet — without this, `GlobalFonts.families` wouldn't include them and a
  // fresh MCP child would under-report what actually renders.
  ensureBundledFontsRegistered();

  const bundled = BUNDLED_FONT_FAMILIES.map((family) => ({
    family,
    weights: BUNDLED_FONTS.filter((f) => f.family === family).map((f) => f.weight),
  }));

  const allSystem = GlobalFonts.families
    .map((f) => f.family)
    .filter((family) => !isBundledFamily(family))
    .sort((a, b) => a.localeCompare(b));
  const systemTruncated = allSystem.length > SYSTEM_FONT_LIMIT;
  const system = allSystem.slice(0, SYSTEM_FONT_LIMIT);

  const db = getDb();
  const scopeFilter = params.pieceId
    ? or(isNull(files.pieceId), eq(files.pieceId, params.pieceId))
    : isNull(files.pieceId);
  const uploadedRows = db
    .select()
    .from(files)
    .where(and(eq(files.type, "font"), scopeFilter))
    .all();
  const uploaded = uploadedRows.map((row) => ({
    family: cssFamilyForFontFile(row.id),
    fileId: row.id,
  }));

  return {
    success: true,
    data: {
      bundled,
      system,
      systemTruncated,
      uploaded,
      note:
        "System fonts are NOT portable across platforms — macOS, Windows, and Linux ship different sets, so a piece that names one may render in a fallback face on another machine. Prefer a bundled family for anything that must look the same everywhere.",
    },
  };
}

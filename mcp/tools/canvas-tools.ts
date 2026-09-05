import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { loadComposition } from "@/lib/composition/persistence";
import { setCompositionDimensions } from "@/lib/composition/dimensions";
import { mcpLogger as logger } from "@/lib/logger";
import type { ToolResult } from "./types";
import type {
  RetrieveAssetsDimensionsParams,
  UpdateCompositionDimensionsParams,
} from "./schemas";

interface AssetDims {
  mediaWidth: number | null;
  mediaHeight: number | null;
  aspect: number | null;
  isVertical: boolean | null;
}

function dims(file: { mediaWidth: number | null; mediaHeight: number | null }): AssetDims {
  const w = file.mediaWidth;
  const h = file.mediaHeight;
  if (!w || !h) {
    return { mediaWidth: w, mediaHeight: h, aspect: null, isVertical: null };
  }
  return {
    mediaWidth: w,
    mediaHeight: h,
    aspect: Math.round((w / h) * 10000) / 10000,
    isVertical: h > w,
  };
}

export async function retrieveAssetsDimensions(
  params: RetrieveAssetsDimensionsParams,
): Promise<ToolResult> {
  const db = getDb();
  const [piece] = db.select().from(pieces).where(eq(pieces.id, params.pieceId)).limit(1).all();
  if (!piece) {
    return { success: false, error: `Piece not found: ${params.pieceId}` };
  }

  const { manifest } = await loadComposition(params.pieceId);

  // Canvas scenes reference no file — every media reference is an overlay.
  const fileIds = new Set<string>();
  for (const o of manifest.overlays ?? []) {
    if (o.kind === "video" || o.kind === "image") fileIds.add(o.fileId);
  }

  const fileRows =
    fileIds.size > 0
      ? db.select().from(files).where(inArray(files.id, Array.from(fileIds))).all()
      : [];
  const fileById = new Map(fileRows.map((f) => [f.id, f]));

  const videoOverlays = (manifest.overlays ?? [])
    .filter((o) => o.kind === "video")
    .map((o) => {
      const f = fileById.get(o.fileId);
      const d = f
        ? dims(f)
        : { mediaWidth: null, mediaHeight: null, aspect: null, isVertical: null };
      return {
        overlayId: o.id,
        fileId: o.fileId,
        startTime: o.startTime,
        duration: o.duration,
        rect: o.rect,
        ...d,
      };
    });

  const imageOverlays = (manifest.overlays ?? [])
    .filter((o) => o.kind === "image")
    .map((o) => {
      const f = fileById.get(o.fileId);
      const d = f
        ? dims(f)
        : { mediaWidth: null, mediaHeight: null, aspect: null, isVertical: null };
      return {
        overlayId: o.id,
        fileId: o.fileId,
        startTime: o.startTime,
        duration: o.duration,
        rect: o.rect,
        ...d,
      };
    });

  const compositionAspect =
    manifest.height > 0 ? Math.round((manifest.width / manifest.height) * 10000) / 10000 : null;

  return {
    success: true,
    data: {
      composition: {
        width: manifest.width,
        height: manifest.height,
        aspect: compositionAspect,
        isVertical: manifest.height > manifest.width,
      },
      videoOverlays,
      imageOverlays,
    },
  };
}

export async function updateCompositionDimensions(
  params: UpdateCompositionDimensionsParams,
): Promise<ToolResult> {
  const { pieceId, width, height } = params;
  if (width <= 0 || height <= 0) {
    return { success: false, error: "width and height must be positive" };
  }
  const db = getDb();
  const [piece] = db.select().from(pieces).where(eq(pieces.id, pieceId)).limit(1).all();
  if (!piece) {
    return { success: false, error: `Piece not found: ${pieceId}` };
  }

  const result = await setCompositionDimensions(pieceId, width, height);

  logger.info(
    {
      tag: "composition",
      op: "update_dimensions",
      pieceId,
      from: { w: result.previousWidth, h: result.previousHeight },
      to: { w: result.width, h: result.height },
      warnings: result.warnings.length,
    },
    "update_composition_dimensions",
  );

  return { success: true, data: { ...result } };
}

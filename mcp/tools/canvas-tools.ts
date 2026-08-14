import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { loadComposition, loadManifest, saveManifest } from "@/lib/composition/persistence";
import { navigationEmitter } from "@/lib/navigation-events";
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

  const manifest = await loadManifest(pieceId);
  const oldWidth = manifest.width;
  const oldHeight = manifest.height;
  manifest.width = width;
  manifest.height = height;

  const warnings: string[] = [];
  for (const o of manifest.overlays ?? []) {
    const rect = o.rect;
    const rightEdge = rect.x + rect.width;
    const bottomEdge = rect.y + rect.height;
    if (rightEdge > width || bottomEdge > height || rect.x < 0 || rect.y < 0) {
      warnings.push(
        `Overlay ${o.id} (${o.kind}) rect ${JSON.stringify(rect)} extends beyond new ${width}×${height} bounds.`,
      );
    }
  }

  await saveManifest(pieceId, manifest);

  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });

  logger.info(
    {
      pieceId,
      from: { w: oldWidth, h: oldHeight },
      to: { w: width, h: height },
      warnings: warnings.length,
    },
    "update_composition_dimensions",
  );

  return {
    success: true,
    data: {
      width,
      height,
      previousWidth: oldWidth,
      previousHeight: oldHeight,
      warnings,
    },
  };
}

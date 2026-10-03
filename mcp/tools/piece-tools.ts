/** Piece metadata tool implementations */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema";
import type { ToolContext, ToolResult } from "./types";
import type { UpdatePieceParams, UpdatePieceNameParams, UpdatePieceDescriptionParams } from "./schemas";

/** `libi.update_piece`: set the name (and/or description) of a piece. A name goes through
 *  `updatePieceName`, which leaves a name the user set by hand alone; a description alone through
 *  `updatePieceDescription`. Neither is an error the caller can recover from by guessing. */
export async function updatePiece(ctx: ToolContext, params: UpdatePieceParams): Promise<ToolResult> {
  if (params.name !== undefined) return updatePieceName(ctx, { ...params, name: params.name });
  if (params.description !== undefined) return updatePieceDescription(ctx, { ...params, description: params.description });
  return { success: false, error: "libi.update_piece needs `name` and/or `description`." };
}

export async function updatePieceName(
  ctx: ToolContext,
  params: UpdatePieceNameParams,
): Promise<ToolResult> {
  const { name, description } = params;
  const db = getDb();

  // Check if the user has manually set the name
  const [piece] = await db
    .select()
    .from(pieces)
    .where(eq(pieces.id, ctx.pieceId));

  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  // Only update name if user hasn't set it manually
  if (!piece?.nameSetByUser) {
    updateData.name = name;
  }

  if (description !== undefined) {
    updateData.description = description;
  }

  await db.update(pieces).set(updateData).where(eq(pieces.id, ctx.pieceId));

  return { success: true, data: { name, description } };
}

export async function updatePieceDescription(
  ctx: ToolContext,
  params: UpdatePieceDescriptionParams,
): Promise<ToolResult> {
  const { description } = params;
  const db = getDb();

  await db
    .update(pieces)
    .set({ description, updatedAt: new Date() })
    .where(eq(pieces.id, ctx.pieceId));

  return { success: true, data: { description } };
}

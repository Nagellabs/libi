/** Piece metadata tool implementations */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema";
import type { ToolContext, ToolResult } from "./types";
import type { UpdatePieceNameParams, UpdatePieceDescriptionParams } from "./schemas";

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

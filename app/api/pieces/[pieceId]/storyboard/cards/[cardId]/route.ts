import { NextResponse } from "next/server";
import { updateCardFields, type CardPatch } from "@/lib/storyboard/repo";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ pieceId: string; cardId: string }> },
) {
  const { pieceId, cardId } = await ctx.params;
  const patch = (await req.json().catch(() => null)) as CardPatch | null;
  if (!patch || typeof patch !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const card = await updateCardFields(pieceId, cardId, patch);
  if (!card) return NextResponse.json({ error: "card not found" }, { status: 404 });
  return NextResponse.json({ card });
}

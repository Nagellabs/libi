import { NextResponse } from "next/server";
import { selectClipTake, hideClipTake } from "@/lib/storyboard/repo";
import { placeCardOverlay } from "@/lib/storyboard/place-overlay";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ pieceId: string; cardId: string }> },
) {
  const { pieceId, cardId } = await ctx.params;
  const { takeId } = (await req.json().catch(() => ({}))) as { takeId?: string };
  if (!takeId) return NextResponse.json({ error: "takeId required" }, { status: 400 });
  const card = await selectClipTake(pieceId, cardId, takeId);
  if (!card) return NextResponse.json({ error: "card or take not found" }, { status: 404 });
  if (card.selectedClipId) await placeCardOverlay(pieceId, card);
  return NextResponse.json({ ok: true, selectedClipId: card.selectedClipId });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ pieceId: string; cardId: string }> },
) {
  const { pieceId, cardId } = await ctx.params;
  const { takeId } = (await req.json().catch(() => ({}))) as { takeId?: string };
  if (!takeId) return NextResponse.json({ error: "takeId required" }, { status: 400 });
  const card = await hideClipTake(pieceId, cardId, takeId);
  if (!card) return NextResponse.json({ error: "card not found" }, { status: 404 });
  return NextResponse.json({ ok: true, selectedClipId: card.selectedClipId });
}

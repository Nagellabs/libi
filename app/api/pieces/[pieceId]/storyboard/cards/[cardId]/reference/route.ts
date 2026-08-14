import { NextResponse } from "next/server";
import { setCardReference, clearCardReference } from "@/lib/storyboard/repo";

type Body = { paramKey?: string; fromCardId?: string | null };

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ pieceId: string; cardId: string }> },
) {
  const { pieceId, cardId } = await ctx.params;
  const { paramKey, fromCardId } = (await req.json().catch(() => ({}))) as Body;
  if (!paramKey) return NextResponse.json({ error: "paramKey required" }, { status: 400 });
  const card =
    fromCardId == null
      ? await clearCardReference(pieceId, cardId, paramKey)
      : await setCardReference(pieceId, cardId, paramKey, { fromCardId });
  if (!card) return NextResponse.json({ error: "card not found" }, { status: 404 });
  return NextResponse.json({ card });
}

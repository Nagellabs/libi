import { NextResponse } from "next/server";
import { getPieceState } from "@/lib/composition/lifecycle";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  try {
    const state = await getPieceState(pieceId);
    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 404 });
  }
}

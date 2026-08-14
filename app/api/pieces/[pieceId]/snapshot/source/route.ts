import { NextResponse } from "next/server";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import { EMPTY_MANIFEST } from "@/lib/composition/persistence";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  try {
    const snapshot = await loadCurrentSnapshot(pieceId);
    return NextResponse.json(snapshot ?? EMPTY_MANIFEST);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

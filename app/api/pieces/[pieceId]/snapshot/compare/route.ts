import { NextResponse } from "next/server";
import { compareStates, getPieceState } from "@/lib/composition/lifecycle";
import { loadManifest, EMPTY_MANIFEST } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  try {
    const snapshot = await loadCurrentSnapshot(pieceId);
    const draft = await loadManifest(pieceId);
    const diff = compareStates(snapshot ?? EMPTY_MANIFEST, draft);
    const state = await getPieceState(pieceId);
    return NextResponse.json({ hasDraft: state.hasDraft, ...diff });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

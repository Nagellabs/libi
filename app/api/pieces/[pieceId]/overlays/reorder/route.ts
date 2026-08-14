import { NextResponse } from "next/server";
import { reorderOverlaysInManifest } from "@/lib/composition/persistence";
import { navigationEmitter } from "@/lib/navigation-events";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

/**
 * POST /api/pieces/[pieceId]/overlays/reorder
 *
 * Atomically rewrite the z-order of ALL overlays in ONE manifest save (first id
 * = back-most = z 0). This replaces firing N concurrent per-overlay z PATCHes,
 * which raced on the manifest (read-modify-write → last-writer-wins) and made a
 * timeline reorder "snap back" to the old order on refetch.
 *
 * Body: `{ overlayIdsInZOrder: string[] }`.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { pieceId } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = (raw as { overlayIdsInZOrder?: unknown })?.overlayIdsInZOrder;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) {
    return NextResponse.json(
      { error: "Invalid body", details: "overlayIdsInZOrder must be a string[]" },
      { status: 400 },
    );
  }

  await reorderOverlaysInManifest(pieceId, ids as string[]);

  try {
    navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  } catch {
    /* fire-and-forget */
  }

  return NextResponse.json({ success: true, count: ids.length });
}

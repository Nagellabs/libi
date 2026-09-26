import { loadComposition } from "@/lib/composition/persistence";
import { markLegacyScenesNoticed } from "@/lib/db/settings";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

/**
 * POST — the editor has told the user that this piece's canvas-scene layers
 * from libi 0.1.0/0.1.1 were not loaded. Recorded in settings, so the notice
 * stays "once per piece" across launches of the packaged app, whose origin
 * (and so its browser storage) changes with every launch's port.
 *
 * Only a piece that really carries legacy scenes is recorded: anything else
 * (an unknown id, a piece without scenes) answers 404 and writes nothing, so
 * the settings list can't grow with ids that never needed a notice.
 */
export async function POST(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  let legacyScenes = 0;
  try {
    ({ legacyScenes } = await loadComposition(pieceId));
  } catch {
    legacyScenes = 0;
  }
  if (legacyScenes <= 0) {
    return Response.json({ success: false, error: "No canvas-scene layers to acknowledge for this piece." }, { status: 404 });
  }
  markLegacyScenesNoticed(pieceId);
  return Response.json({ success: true });
}

import {
  loadManifest,
  removeSceneAndUpdateManifest,
} from "@/lib/composition/persistence";
import { navigationEmitter } from "@/lib/navigation-events";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ pieceId: string; sceneId: string }> },
) {
  const { pieceId, sceneId } = await params;
  const manifest = await loadManifest(pieceId);
  if (!manifest.sceneOrder.includes(sceneId)) {
    return Response.json({ error: `Scene ${sceneId} not found` }, { status: 404 });
  }
  const { removedClips } = await removeSceneAndUpdateManifest(pieceId, sceneId);
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return Response.json({ sceneId, removedClips });
}

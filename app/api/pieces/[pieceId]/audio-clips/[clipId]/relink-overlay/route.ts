import { audioRelinkOverlay } from "@/mcp/tools/audio-clip-tools";
import { navigationEmitter } from "@/lib/navigation-events";

/**
 * POST /api/pieces/[pieceId]/audio-clips/[clipId]/relink-overlay
 * Body: { overlayId } — re-attach a detached (standalone) clip to its video
 * overlay (inverse of /unlink for the overlay case). The composition refetch
 * moves it back into the combined track.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ pieceId: string; clipId: string }> },
) {
  const { pieceId, clipId } = await params;
  const body = (await req.json().catch(() => ({}))) as { overlayId?: string };
  if (!body.overlayId) return Response.json({ error: "overlayId required" }, { status: 400 });
  const result = await audioRelinkOverlay({ pieceId }, { pieceId, clipId, overlayId: body.overlayId });
  if (!result.success) return Response.json({ error: result.error }, { status: 400 });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return Response.json(result.data);
}

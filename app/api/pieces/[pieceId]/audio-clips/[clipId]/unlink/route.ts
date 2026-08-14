import { audioUnlink } from "@/mcp/tools/audio-clip-tools";
import { navigationEmitter } from "@/lib/navigation-events";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ pieceId: string; clipId: string }> },
) {
  const { pieceId, clipId } = await params;
  const result = await audioUnlink({ pieceId }, { pieceId, clipId });
  if (!result.success) return Response.json({ error: result.error }, { status: 400 });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return Response.json(result.data);
}

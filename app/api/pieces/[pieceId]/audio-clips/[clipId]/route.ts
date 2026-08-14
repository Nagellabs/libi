import { audioUpdateClip, audioRemoveClip } from "@/mcp/tools/audio-clip-tools";
import { audioUpdateClipSchema } from "@/mcp/tools/schemas";
import { navigationEmitter } from "@/lib/navigation-events";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ pieceId: string; clipId: string }> },
) {
  const { pieceId, clipId } = await params;
  const body = await req.json();
  const parsed = audioUpdateClipSchema.safeParse({ ...body, pieceId, clipId });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  const result = await audioUpdateClip({ pieceId }, parsed.data);
  if (!result.success) return Response.json({ error: result.error }, { status: 400 });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return Response.json(result.data);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ pieceId: string; clipId: string }> },
) {
  const { pieceId, clipId } = await params;
  const result = await audioRemoveClip({ pieceId }, { pieceId, clipId });
  if (!result.success) return Response.json({ error: result.error }, { status: 400 });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return Response.json(result.data);
}

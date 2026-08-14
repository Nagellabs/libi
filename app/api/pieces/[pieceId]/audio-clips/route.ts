import { audioAddClip } from "@/mcp/tools/audio-clip-tools";
import { audioAddClipSchema } from "@/mcp/tools/schemas";
import { navigationEmitter } from "@/lib/navigation-events";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ pieceId: string }> },
) {
  const { pieceId } = await params;
  const body = await req.json();
  const parsed = audioAddClipSchema.safeParse({ ...body, pieceId });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  const result = await audioAddClip({ pieceId }, parsed.data);
  if (!result.success) return Response.json({ error: result.error }, { status: 400 });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return Response.json(result.data);
}

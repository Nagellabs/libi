import { audioDuckEnable, audioDuckDisable, audioDuckUpdate } from "@/mcp/tools/audio-duck-tools";
import {
  audioDuckEnableSchema,
  audioDuckUpdateSchema,
} from "@/mcp/tools/schemas";
import { navigationEmitter } from "@/lib/navigation-events";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ pieceId: string; clipId: string }> },
) {
  const { pieceId, clipId } = await params;
  const body = await req.json();
  const parsed = audioDuckEnableSchema.safeParse({ ...body, pieceId, clipId });
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  const result = await audioDuckEnable({ pieceId }, parsed.data);
  if (!result.success) return Response.json({ error: result.error }, { status: 400 });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return Response.json(result.data);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ pieceId: string; clipId: string }> },
) {
  const { pieceId, clipId } = await params;
  const body = await req.json();
  const parsed = audioDuckUpdateSchema.safeParse({ ...body, pieceId, clipId });
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  const result = await audioDuckUpdate({ pieceId }, parsed.data);
  if (!result.success) return Response.json({ error: result.error }, { status: 400 });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return Response.json(result.data);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ pieceId: string; clipId: string }> },
) {
  const { pieceId, clipId } = await params;
  const result = await audioDuckDisable({ pieceId }, { pieceId, clipId });
  if (!result.success) return Response.json({ error: result.error }, { status: 400 });
  navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  return Response.json(result.data);
}

import { splitClip, deleteClip, duplicateClip } from "@/lib/composition/clip-ops";
import { navigationEmitter } from "@/lib/navigation-events";

/**
 * Unified timeline clip operations for the right-click menu — POST with
 * `{ op, targetId, atTime?, ripple? }`. Shares the exact `lib/composition/clip-ops`
 * core with the libi.split_clip / delete_clip / duplicate_clip MCP tools, so the
 * user and the agent get identical behaviour. Delete removes the timeline entity
 * only; the source file is never touched. `ripple: true` on a delete additionally
 * closes the gap by shifting every overlay/audio clip starting at/after the
 * deleted clip's end time left by its duration — default false leaves the gap.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ pieceId: string }> },
) {
  const { pieceId } = await params;
  const body = (await req.json()) as {
    op?: "split" | "delete" | "duplicate";
    targetId?: string;
    atTime?: number;
    ripple?: boolean;
  };
  const { op, targetId, atTime, ripple } = body;

  if (!targetId || typeof targetId !== "string") {
    return Response.json({ error: "targetId is required" }, { status: 400 });
  }

  if (op === "split") {
    if (typeof atTime !== "number") {
      return Response.json({ error: "atTime (seconds) is required for split" }, { status: 400 });
    }
    const result = await splitClip(pieceId, targetId, atTime);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
    return Response.json(result);
  }

  if (op === "delete") {
    const result = await deleteClip(pieceId, targetId, { ripple: ripple === true });
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
    return Response.json(result);
  }

  if (op === "duplicate") {
    const result = await duplicateClip(pieceId, targetId);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
    return Response.json(result);
  }

  return Response.json({ error: `unknown op: ${op}` }, { status: 400 });
}

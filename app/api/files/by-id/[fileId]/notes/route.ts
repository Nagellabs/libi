import { NextResponse } from "next/server";
import { updateFileNotes } from "@/mcp/tools/file-tools";
import { navigationEmitter } from "@/lib/navigation-events";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { fileId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const notes =
    typeof (body as { notes?: unknown })?.notes === "string"
      ? (body as { notes: string }).notes
      : null;
  if (notes === null) {
    return NextResponse.json({ error: "notes is required" }, { status: 400 });
  }
  const mode =
    (body as { mode?: unknown })?.mode === "replace" ? "replace" : "append";

  const result = await updateFileNotes({ fileId, notes, mode });
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  // Push a refresh so connected SSE clients re-fetch the file detail.
  // Matches the rename route's payload shape: piece-scoped uses queryKey
  // "piece" + pieceId; global files use queryKey "files".
  const file = result.data as { pieceId: string | null };
  if (file.pieceId) {
    navigationEmitter.emit("refresh_query", {
      queryKey: "piece",
      pieceId: file.pieceId,
    });
  } else {
    navigationEmitter.emit("refresh_query", { queryKey: "files" });
  }

  return NextResponse.json({ success: true, file: result.data });
}

import { acknowledgeRemovedTranscripts } from "@/lib/analysis/removed-transcripts";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

/**
 * POST { fileIds } — the editor has told the user that these files'
 * transcripts were removed by the boot re-time (a FLAC-in-MP4 cut whose old
 * decode was garbled; lib/analysis/removed-transcripts.ts). Forgets them, so
 * GET …/composition stops reporting them. Only entries of this piece or of the
 * library go; anything else answers 404 and writes nothing.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  let fileIds: string[] = [];
  try {
    const body = (await req.json()) as { fileIds?: unknown };
    if (Array.isArray(body.fileIds)) fileIds = body.fileIds.filter((v): v is string => typeof v === "string");
  } catch {
    return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (fileIds.length === 0 || acknowledgeRemovedTranscripts(pieceId, fileIds) === 0) {
    return Response.json({ success: false, error: "No removed transcripts to acknowledge for this piece." }, { status: 404 });
  }
  return Response.json({ success: true });
}

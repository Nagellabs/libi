import { loadComposition } from "@/lib/composition/persistence";
import { isLegacyScenesNoticed } from "@/lib/db/settings";
import { pendingRemovedTranscripts } from "@/lib/analysis/removed-transcripts";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;

  try {
    const { manifest, legacyScenes } = await loadComposition(pieceId);
    return Response.json({
      manifest,
      audioClips: manifest.audioClips ?? [],
      // Canvas scenes from libi 0.1.0/0.1.1 the file still holds, which were
      // not loaded, and whether the user has already been told — the editor
      // says so once per piece (hooks/editor/use-legacy-scenes-notice.ts).
      legacyScenes,
      legacyScenesNoticed: legacyScenes > 0 && isLegacyScenesNoticed(pieceId),
      // Transcripts of this piece's (or the library's) files that a boot
      // migration removed, not yet told: the editor says so once
      // (hooks/editor/use-removed-transcripts-notice.ts).
      removedTranscripts: pendingRemovedTranscripts(pieceId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

import { loadComposition } from "@/lib/composition/persistence";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;

  try {
    const { manifest } = await loadComposition(pieceId);
    return Response.json({
      manifest,
      audioClips: manifest.audioClips ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

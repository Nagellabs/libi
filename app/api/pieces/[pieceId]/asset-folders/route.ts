import { NextResponse } from "next/server";
import { listAssetsTool } from "@/mcp/tools/asset-folder-tools";
import { listAssetFoldersForScope, recursiveAssetCounts } from "@/lib/asset-folders/repo";

export async function GET(req: Request, { params }: { params: Promise<{ pieceId: string }> }) {
  const { pieceId } = await params;
  const searchParams = new URL(req.url).searchParams;
  if (searchParams.get("tree") === "1") {
    const counts = recursiveAssetCounts(pieceId);
    const folders = listAssetFoldersForScope(pieceId).map((f) => ({
      ...f,
      assetCount: counts.get(f.id) ?? 0,
    }));
    return NextResponse.json({ folders });
  }
  const folderId = searchParams.get("folderId") ?? undefined;
  const r = await listAssetsTool({ pieceId, folderId });
  return NextResponse.json(r.success ? r.data : { error: r.error }, { status: r.success ? 200 : 400 });
}

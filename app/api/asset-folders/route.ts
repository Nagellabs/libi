import { NextResponse } from "next/server";
import { listAssetsTool, createAssetFolderTool } from "@/mcp/tools/asset-folder-tools";
import { listAssetFoldersForScope, recursiveAssetCounts } from "@/lib/asset-folders/repo";

export async function GET(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  if (searchParams.get("tree") === "1") {
    const counts = recursiveAssetCounts(null);
    const folders = listAssetFoldersForScope(null).map((f) => ({
      ...f,
      assetCount: counts.get(f.id) ?? 0,
    }));
    return NextResponse.json({ folders });
  }
  const folderId = searchParams.get("folderId") ?? undefined;
  const r = await listAssetsTool({ pieceId: null, folderId });
  return NextResponse.json(r.success ? r.data : { error: r.error }, { status: r.success ? 200 : 400 });
}

export async function POST(req: Request) {
  const body = (await req.json()) as { pieceId: string | null; name: string; parentFolderId?: string };
  const r = await createAssetFolderTool(body);
  return NextResponse.json(r.success ? r.data : { error: r.error }, { status: r.success ? 200 : 400 });
}

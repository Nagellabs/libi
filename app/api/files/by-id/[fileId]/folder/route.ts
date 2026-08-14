import { NextResponse } from "next/server";
import { moveAssetTool } from "@/mcp/tools/asset-folder-tools";

export async function PATCH(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  const body = (await req.json()) as { folderId: string | null };
  const r = await moveAssetTool({ fileId, folderId: body.folderId });
  return NextResponse.json(r.success ? r.data : { error: r.error }, { status: r.success ? 200 : 400 });
}

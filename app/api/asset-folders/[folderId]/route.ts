import { NextResponse } from "next/server";
import {
  renameAssetFolderTool,
  moveAssetFolderTool,
  deleteAssetFolderTool,
} from "@/mcp/tools/asset-folder-tools";

export async function PATCH(req: Request, { params }: { params: Promise<{ folderId: string }> }) {
  const { folderId } = await params;
  const body = (await req.json()) as { name?: string; parentFolderId?: string | null };
  if (typeof body.name === "string") {
    const r = await renameAssetFolderTool({ folderId, name: body.name });
    return NextResponse.json(r.success ? r.data : { error: r.error }, { status: r.success ? 200 : 400 });
  }
  if ("parentFolderId" in body) {
    const r = await moveAssetFolderTool({ folderId, parentFolderId: body.parentFolderId ?? null });
    return NextResponse.json(r.success ? r.data : { error: r.error }, { status: r.success ? 200 : 400 });
  }
  return NextResponse.json({ error: "no_op" }, { status: 400 });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ folderId: string }> }) {
  const { folderId } = await params;
  const sp = new URL(req.url).searchParams;
  const mode = (sp.get("mode") as "orphan" | "cascade" | null) ?? "orphan";
  const confirm = sp.get("confirm") === "true";
  const r = await deleteAssetFolderTool({ folderId, mode, confirm });
  return NextResponse.json(r.success ? r.data : { error: r.error }, { status: r.success ? 200 : 400 });
}

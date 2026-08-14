import { navigationEmitter } from "@/lib/navigation-events";
import {
  getFolder,
  listAllFolders,
  renameFolder,
  setFolderParent,
} from "@/lib/folders/repo";
import { wouldCreateCycle } from "@/lib/folders/tree";
import { deleteFolder } from "@/lib/folders/lifecycle";
import type { DeleteFolderMode } from "@/lib/folders/types";

interface RouteParams {
  params: Promise<{ folderId: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const { folderId } = await params;
  const body = await req.json().catch(() => ({}));
  if (!getFolder(folderId)) {
    return Response.json({ error: "folder_not_found" }, { status: 404 });
  }

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return Response.json({ error: "invalid_name" }, { status: 400 });
    renameFolder(folderId, name);
  }

  if (body.parentFolderId !== undefined) {
    const parentId =
      typeof body.parentFolderId === "string" ? body.parentFolderId : null;
    if (parentId && !getFolder(parentId)) {
      return Response.json({ error: "folder_not_found" }, { status: 404 });
    }
    if (wouldCreateCycle(folderId, parentId, listAllFolders())) {
      return Response.json({ error: "cycle_rejected" }, { status: 409 });
    }
    setFolderParent(folderId, parentId);
  }

  navigationEmitter.emit("refresh_query", { queryKey: "folders" });
  return Response.json(getFolder(folderId));
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const { folderId } = await params;
  if (!getFolder(folderId)) {
    return Response.json({ error: "folder_not_found" }, { status: 404 });
  }
  const modeParam = new URL(req.url).searchParams.get("mode");
  const mode: DeleteFolderMode = modeParam === "cascade" ? "cascade" : "orphan";
  const result = await deleteFolder(folderId, mode);
  return Response.json(result);
}

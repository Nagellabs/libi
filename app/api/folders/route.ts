import { navigationEmitter } from "@/lib/navigation-events";
import {
  createFolder,
  getFolder,
  listAllFolders,
  pieceCountsByFolder,
} from "@/lib/folders/repo";

export async function GET() {
  const counts = pieceCountsByFolder();
  const folders = listAllFolders().map((f) => ({
    id: f.id,
    name: f.name,
    parentFolderId: f.parentFolderId,
    pieceCount: counts.get(f.id) ?? 0,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }));
  return Response.json({ folders });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return Response.json({ error: "invalid_name" }, { status: 400 });
  }
  const parentFolderId =
    typeof body.parentFolderId === "string" ? body.parentFolderId : null;
  if (parentFolderId && !getFolder(parentFolderId)) {
    return Response.json({ error: "folder_not_found" }, { status: 404 });
  }
  const folder = createFolder({ name, parentFolderId });
  navigationEmitter.emit("refresh_query", { queryKey: "folders" });
  return Response.json(folder, { status: 201 });
}

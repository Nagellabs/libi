import { getJobManager } from "@/lib/jobs/manager";
import { navigationEmitter } from "@/lib/navigation-events";
import { getFolder, listAllFolders } from "@/lib/folders/repo";
import { resolveCopyName } from "@/lib/duplication/copy-name";
import { cloneFolderSubtree } from "@/lib/duplication/clone-folder";
import { drivePieceDupJob } from "@/lib/duplication/run";

interface RouteParams {
  params: Promise<{ folderId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { folderId } = await params;
  const body = await req.json().catch(() => ({}));
  const source = body.source === "snapshot" ? "snapshot" : "draft";

  const src = getFolder(folderId);
  if (!src) return Response.json({ error: "folder_not_found" }, { status: 404 });

  const existing = listAllFolders().map((f) => f.name);
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : resolveCopyName(src.name, existing);

  const { newFolderId, copies } = cloneFolderSubtree(folderId, name);

  const jm = getJobManager();
  const jobIds: string[] = [];
  for (const c of copies) {
    const enq = await jm.enqueue(
      "piece_dup",
      { sourcePieceId: c.sourcePieceId, newPieceId: c.newPieceId, source },
      { pieceId: c.newPieceId },
    );
    const jobId = enq.status !== "matching_completed" ? enq.jobId : enq.existingJob.jobId;
    // enqueue() only inserts the row; kick off the runner in the background.
    drivePieceDupJob(enq);
    jobIds.push(jobId);
  }
  navigationEmitter.emit("refresh_query", { queryKey: "folders" });
  navigationEmitter.emit("refresh_query", { queryKey: "pieces" });
  return Response.json(
    { folderId: newFolderId, name, jobIds, pieceCount: copies.length },
    { status: 201 },
  );
}

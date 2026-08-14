import { getJobManager } from "@/lib/jobs/manager";
import { navigationEmitter } from "@/lib/navigation-events";
import { createDuplicatePieceShell } from "@/lib/duplication/start";
import { drivePieceDupJob } from "@/lib/duplication/run";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  const body = await req.json().catch(() => ({}));
  const source = body.source === "snapshot" ? "snapshot" : "draft";

  let shell: { newPieceId: string; name: string };
  try {
    shell = createDuplicatePieceShell(pieceId, {
      name: typeof body.name === "string" ? body.name : undefined,
      folderId: body.folderId === undefined ? undefined : (body.folderId ?? null),
    });
  } catch (err) {
    if (err instanceof Error && err.message === "piece_not_found") {
      return Response.json({ error: "piece_not_found" }, { status: 404 });
    }
    throw err;
  }

  const enq = await getJobManager().enqueue(
    "piece_dup",
    { sourcePieceId: pieceId, newPieceId: shell.newPieceId, source },
    { pieceId: shell.newPieceId },
  );
  const jobId = enq.status !== "matching_completed" ? enq.jobId : enq.existingJob.jobId;
  // enqueue() only inserts the row; kick off the runner in the background.
  drivePieceDupJob(enq);
  navigationEmitter.emit("refresh_query", { queryKey: "pieces" });
  return Response.json(
    { pieceId: shell.newPieceId, name: shell.name, jobId },
    { status: 201 },
  );
}

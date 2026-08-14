import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { enqueueFilmstripGen } from "@/lib/filmstrip/enqueue";

/**
 * GET  /api/files/by-id/[fileId]/filmstrip-status — JSON status for the polling
 *      hook. `?ensure=1` lazily enqueues generation when the sprite is idle or
 *      failed (so the editor kicks off generation the first time a video bar
 *      needs a strip).
 * POST /api/files/by-id/[fileId]/filmstrip-status — same lazy enqueue, explicit.
 *
 * Mirrors the proxy-status route shape.
 */
interface FilmstripStatusBody {
  status: "idle" | "generating" | "ready" | "failed";
  filename: string | null;
  frames: number | null;
  height: number | null;
  generatedAt: string | null;
}

function loadFile(fileId: string) {
  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  return file ?? null;
}

function ensureIfNeeded(file: NonNullable<ReturnType<typeof loadFile>>): void {
  // Only kick off when there's nothing useful in flight or on disk. A
  // `generating` / `ready` row is left alone (the hook polls).
  if (file.type !== "video") return;
  if (file.filmstripStatus === "idle" || file.filmstripStatus === "failed") {
    enqueueFilmstripGen(file.id, {
      pieceId: file.pieceId,
      regenerate: file.filmstripStatus === "failed",
    });
  }
}

function statusBody(
  file: NonNullable<ReturnType<typeof loadFile>>,
): FilmstripStatusBody {
  return {
    status: file.filmstripStatus,
    filename: file.filmstripFilename,
    frames: file.filmstripFrames,
    height: file.filmstripHeight,
    generatedAt: file.filmstripGeneratedAt
      ? file.filmstripGeneratedAt.toISOString()
      : null,
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;
  const file = loadFile(fileId);
  if (!file) return new Response("File not found", { status: 404 });

  const ensure = new URL(req.url).searchParams.get("ensure") === "1";
  if (ensure) ensureIfNeeded(file);

  return Response.json(statusBody(file));
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;
  const file = loadFile(fileId);
  if (!file) return new Response("File not found", { status: 404 });

  ensureIfNeeded(file);
  return Response.json(statusBody(file));
}

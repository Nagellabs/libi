import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import * as fs from "node:fs";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

/**
 * GET /api/files/by-id/[fileId]/location
 *
 * Resolve a file row to its absolute path on disk, plus whether that path
 * still exists. Backs the "Reveal in Finder" context-menu item and the
 * Location row on the asset Summary tab — both need the absolute path,
 * which is otherwise server-only (`FileRecord.storagePath` is relative).
 *
 * Deliberately NOT non-oracle, unlike its sibling `/api/shell/reveal`.
 * That route accepts a caller-supplied arbitrary path under `$HOME`, so
 * answering "does it exist" would turn it into a filesystem probe over
 * paths the caller invented — that oracle is exactly what its non-oracle
 * `{ ok: true }`-always shape was built to close. This route never takes
 * a caller-supplied path: the only input is a `fileId`, and the response
 * only describes the path derived from the DB row it resolves to, so a
 * caller can only ever learn the existence of a path they could already
 * name by owning that `fileId`. It does not reopen the oracle.
 *
 * This route is NOT behind an origin/CSRF check — GET/HEAD/OPTIONS are
 * short-circuited as "safe" in `lib/security/request-guard.ts` before any
 * origin comparison runs. What actually stops a cross-origin page from
 * reading the response is that this app sets no `Access-Control-Allow-*`
 * headers anywhere, so the browser's same-origin policy blocks a foreign
 * page from reading it even if it can trigger the GET. Do not add a
 * `?path=` override or CORS headers on the strength of an origin check
 * that does not run here — it doesn't.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  const { fileId } = await params;
  const db = getDb();
  const [row] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    // Covers getStorage() and existsSync() too, not just localPath below —
    // neither is expected to throw (getStorage is a pure singleton
    // constructor, existsSync returns false rather than throwing), but the
    // one branch that actually can throw is localPath on a traversal-shaped
    // pieceId/filename. DB rows are not shaped that way in practice; return
    // a clean 500 rather than a stack trace if one ever is.
    const storage = await getStorage();
    const abs = storage.localPath(row.pieceId, row.filename);
    return NextResponse.json({ path: abs, exists: fs.existsSync(abs) });
  } catch {
    return NextResponse.json({ error: "Unresolvable" }, { status: 500 });
  }
}

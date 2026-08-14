import * as path from "node:path";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import { renderCandidateFrames } from "@/lib/tracking/identity-candidates-render";
import { serverLogger as logger } from "@/lib/logger";
import type { IdentityCandidate } from "@/lib/tracking/identity-candidates";

interface Body {
  pieceId?: string;
  fileId?: string;
  candidates?: IdentityCandidate[];
  range?: { start: number; end: number };
  framesPerWindow?: number;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  if (!body.fileId || !body.range || !Array.isArray(body.candidates)) {
    return NextResponse.json(
      { success: false, error: "provide fileId, range, and candidates" },
      { status: 400 },
    );
  }

  const db = getDb();
  const fileRows = await db.select().from(files).where(eq(files.id, body.fileId)).limit(1);
  const file = fileRows[0];
  if (!file) return NextResponse.json({ success: false, error: "file not found" }, { status: 404 });
  if (!file.pieceId)
    return NextResponse.json(
      { success: false, error: "file not assigned to a piece" },
      { status: 400 },
    );

  const srcPath = path.isAbsolute(file.storagePath)
    ? file.storagePath
    : path.join(getLibiStorageDir(), file.storagePath);

  const frameW = file.mediaWidth ?? 1920;
  const frameH = file.mediaHeight ?? 1080;

  try {
    const frames = await renderCandidateFrames({
      srcPath,
      frameW,
      frameH,
      candidates: body.candidates,
      range: body.range,
      framesPerWindow: body.framesPerWindow,
    });
    return NextResponse.json({ success: true, frames });
  } catch (e) {
    logger.error(
      {
        tag: "tracking-verify",
        op: "identity_candidates_render.fail",
        err: e instanceof Error ? e.message : String(e),
      },
      "identity-candidates render failed",
    );
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

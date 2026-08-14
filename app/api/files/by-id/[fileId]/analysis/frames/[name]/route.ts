import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getFramesDir } from "@/lib/analysis/storage";

interface RouteContext {
  params: Promise<{ fileId: string; name: string }>;
}

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const { fileId, name } = await ctx.params;

  // Strip path traversal — only allow simple basenames.
  const safeName = path.basename(name);
  if (safeName !== name || !/^frame-\d{4,}\.png$/.test(safeName)) {
    return NextResponse.json({ error: "invalid frame name" }, { status: 400 });
  }

  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!file) return NextResponse.json({ error: "file not found" }, { status: 404 });

  const dir = getFramesDir(file.pieceId, file.id);
  const full = path.join(dir, safeName);
  if (!fs.existsSync(full)) return NextResponse.json({ error: "frame not found" }, { status: 404 });

  // Re-check containment against the REAL (symlink-resolved) path, not just
  // the basename() strip above. This route doesn't go through
  // lib/storage/local.ts (see its `realPathForRead` doc comment for the full
  // rationale), but the same gap applies here: a symlink planted inside the
  // frames dir could point outside it, and basename()-only filtering would
  // wave the request straight through.
  let real: string;
  let realDir: string;
  try {
    [real, realDir] = await Promise.all([
      fs.promises.realpath(full),
      fs.promises.realpath(dir),
    ]);
  } catch {
    return NextResponse.json({ error: "frame not found" }, { status: 404 });
  }
  if (real !== realDir && !real.startsWith(realDir + path.sep)) {
    return NextResponse.json({ error: "invalid frame name" }, { status: 400 });
  }

  const buffer = fs.readFileSync(real);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=600",
    },
  });
}

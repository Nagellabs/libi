import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getLibiModelsDir } from "@/lib/libi-home";
import { serveFileWithRange } from "@/lib/http/range";
import { mimeTypeFor } from "@/lib/http/mime";

export async function GET(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: parts } = await context.params;
  // Path-traversal guard: every segment must be safe.
  if (parts.some((p) => p === ".." || p.includes("/") || p.includes("\\"))) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  const abs = path.join(getLibiModelsDir(), ...parts);
  // Resolve and re-check containment.
  const root = path.resolve(getLibiModelsDir());
  const target = path.resolve(abs);
  if (!target.startsWith(root + path.sep) && target !== root) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  // Existence + EISDIR guard: serveFileWithRange uses createReadStream
  // which would either 500 or stream nothing for a directory.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Re-check containment against the REAL (symlink-resolved) path, not just
  // the lexical one above. This route doesn't go through lib/storage/local.ts
  // (see its `realPathForRead` doc comment for the full rationale), but the
  // same gap applies here: a symlink planted inside the models dir could
  // point outside it and the lexical resolve()+startsWith() check above would
  // wave the request straight through.
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([
      fs.promises.realpath(target),
      fs.promises.realpath(root),
    ]);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  return serveFileWithRange({
    filePath: real,
    contentType: mimeTypeFor(real),
    cacheControl: "public, max-age=31536000, immutable",
    request: req,
  });
}

import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { serveFileWithRange } from "@/lib/http/range";
import { EXAMPLE_FILE, POSTER_FILE, isPublishRequestId, publishRequestDir } from "@/lib/templates/cloud/publish-request-media";
import { getPublishRequest } from "@/lib/templates/cloud/publish-requests";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { [EXAMPLE_FILE]: "video/mp4", [POSTER_FILE]: "image/jpeg" };

/**
 * GET → one of a publish request's two files, for its review panel: the
 * example video and the poster the request prepared — exactly the bytes a
 * confirmed publish sends (lib/templates/cloud/publish-request-media.ts).
 *
 * Scoped to the request by construction: the name is one of the two, the id
 * must be a request of this catalog, and the path is built from both — never
 * from anything a caller names. A symlink or anything but a regular file is
 * not served. Never cached: a re-prepare is a new request id, and a file that
 * changed in place makes the request `changed`.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; name: string }> }): Promise<Response> {
  const { id, name } = await ctx.params;
  const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });
  const contentType = TYPES[name];
  if (!contentType || !isPublishRequestId(id) || !getPublishRequest(id)) return notFound();
  const file = path.join(publishRequestDir(id), name);
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) return notFound();
  return serveFileWithRange({
    filePath: file,
    contentType,
    cacheControl: "no-store",
    request: req,
    extraHeaders: { "X-Content-Type-Options": "nosniff" },
  });
}

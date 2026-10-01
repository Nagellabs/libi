import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { serveFileWithRange } from "@/lib/http/range";
import { EXAMPLE_FILE, POSTER_FILE, isPublishRequestId, publishRequestDir } from "@/lib/templates/cloud/publish-request-media";
import { getPublishRequest } from "@/lib/templates/cloud/publish-requests";
import { crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { serverLogger as logger } from "@/lib/logger";

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
  if (!contentType || !isPublishRequestId(id)) return notFound();
  // A well-formed ask for a request's own file that still 404s says which check
  // refused it (a 404 on a just-prepared request's example was seen once and
  // never explained — 0.1.16 suites report, W1b). Ids and the file's name only,
  // never its path. Only for the studio's own page: any other site can guess a
  // well-formed id/name pair and 404 all day, so a cross-site/same-site read
  // (`crossSiteSubresourceRefusal`) still 404s but never warns.
  const refused = (reason: "no_row" | "not_file") => {
    if (crossSiteSubresourceRefusal(req) === null) {
      logger.warn({ tag: "templates-cloud", op: "publish_request_media_not_found", requestId: id, name, reason }, "publish request media not found");
    }
    return notFound();
  };
  if (!getPublishRequest(id)) return refused("no_row");
  const file = path.join(publishRequestDir(id), name);
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) return refused("not_file");
  return serveFileWithRange({
    filePath: file,
    contentType,
    cacheControl: "no-store",
    request: req,
    extraHeaders: { "X-Content-Type-Options": "nosniff" },
  });
}

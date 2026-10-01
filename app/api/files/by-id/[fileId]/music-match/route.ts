import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { matchSongOnPlatforms } from "@/lib/social/music-match";
import { crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

/**
 * Match this song on every connected platform that can attach a licensed copy
 * (addendum §3). Agent-callable — `libi.audio_add_clip` and
 * `libi.set_audio_rights` reach it over loopback, the details panel's
 * "Find again" from the page. It reads the catalog on the user's grant, so
 * another site's request is refused. Never overwrites the user's pick.
 */
export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const { fileId } = await params;
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: "social-music", op: "music_match_refused", reason: refused, fileId }, "refused a cross-site request to match a song");
    return NextResponse.json({ error: "A song is matched only from libi.", code: refused }, { status: 403 });
  }
  const row = getDb().select({ id: files.id, pieceId: files.pieceId }).from(files).where(eq(files.id, fileId)).get();
  if (!row) return NextResponse.json({ error: `File not found: ${fileId}`, code: "not_found" }, { status: 404 });
  const r = await matchSongOnPlatforms(fileId);
  if ("platforms" in r) {
    navigationEmitter.emit("refresh_query", { queryKey: "files", ...(row.pieceId ? { pieceId: row.pieceId } : {}), fileId });
    navigationEmitter.emit("refresh_query", { queryKey: "social", ...(row.pieceId ? { pieceId: row.pieceId } : {}) });
  }
  return NextResponse.json(r);
}

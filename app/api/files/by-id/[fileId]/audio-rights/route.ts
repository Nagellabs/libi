import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { audioTrackSchema } from "@/lib/audio-rights/types";
import { updateAudioRights } from "@/lib/audio-rights/write";
import { scheduleSongRematch } from "@/lib/social/music-match";
import { browserOnlyRefusal } from "@/lib/security/request-guard";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

const bodySchema = z.object({ class: z.enum(["copyrighted", "generated", "owned"]).optional(), track: audioTrackSchema.nullable().optional() }).strict();

/**
 * The file details panel / audio inspector's rights edit. "I own this" is a
 * user-only decision (spec §4.3, §9): `owned` takes the browser-only checks,
 * like the other user-only routes. A track edit or a class other than owned
 * does not.
 */
export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const { fileId } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  if (parsed.data.class === "owned") {
    const refused = browserOnlyRefusal(req);
    if (refused) {
      logger.warn({ tag: "social-music", op: "owned_refused", reason: refused, fileId }, "owned mark refused: not from libi's own page");
      return NextResponse.json({ error: "Only you can mark a track as your own, on libi's own page.", code: "browser_only" }, { status: 403 });
    }
  }
  const r = updateAudioRights(fileId, parsed.data, "user");
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.code === "not_found" ? 404 : 422 });
  // The old match was for a different song (addendum §1): the non-user picks
  // are already gone; match the new one once the user stops typing.
  if (r.trackChanged) scheduleSongRematch(fileId, r.pieceId);
  if (r.pieceId) navigationEmitter.emit("refresh_query", { queryKey: "piece", pieceId: r.pieceId });
  else navigationEmitter.emit("refresh_query", { queryKey: "files" });
  return NextResponse.json({ rights: r.rights });
}

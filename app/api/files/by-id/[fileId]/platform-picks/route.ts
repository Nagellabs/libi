import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { PLATFORM_KEY, pickTrackSchema, type PlatformPick } from "@/lib/audio-rights/types";
import { setPlatformPick } from "@/lib/audio-rights/platform-picks";
import { getSocialSettings } from "@/lib/db/settings";
import type { KnownPlatform } from "@/lib/social/catalog";
import { browserOnlyRefusal } from "@/lib/security/request-guard";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

const account = z.string().min(1).max(128).optional();
const userPick = z.union([
  z.object({ status: z.literal("picked"), track: pickTrackSchema, accountId: account }).strict(),
  z.object({ status: z.literal("draft"), accountId: account }).strict(),
]);
const bodySchema = z.object({ platform: z.string().regex(PLATFORM_KEY), pick: userPick.nullable() }).strict();

/**
 * The user's track for this song on one platform (addendum §6) — from the
 * Posting tab's Music step or the details panel's picker. A user choice, so
 * browser-only; the agent's path is the automatic match
 * (`/api/files/by-id/:fileId/music-match`), which never overrides this.
 */
export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const { fileId } = await params;
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "social-music", op: "platform_pick_refused", reason: refused, fileId }, "platform pick refused: not from libi's own page");
    return NextResponse.json({ error: "A song's track is picked only on libi's own page.", code: "browser_only" }, { status: 403 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  const providerId = getSocialSettings().providerId ?? undefined;
  const pick: PlatformPick | null = parsed.data.pick
    ? { ...parsed.data.pick, decidedBy: "user", decidedAt: new Date().toISOString(), ...(providerId ? { providerId } : {}) }
    : null;
  const r = setPlatformPick(fileId, parsed.data.platform as KnownPlatform, pick, "user");
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.code === "not_found" ? 404 : 422 });
  navigationEmitter.emit("refresh_query", { queryKey: "files", ...(r.pieceId ? { pieceId: r.pieceId } : {}), fileId });
  navigationEmitter.emit("refresh_query", { queryKey: "social", ...(r.pieceId ? { pieceId: r.pieceId } : {}) });
  return NextResponse.json({ rights: r.rights });
}

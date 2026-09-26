import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { getSocialSettings } from "@/lib/db/settings";
import { insertAdLink } from "@/lib/social/links";
import { navigationEmitter } from "@/lib/navigation-events";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";

export const dynamic = "force-dynamic";

const adLinkBodySchema = z.object({
  pieceId: z.string().min(1),
  providerAdId: z.string().min(1),
  platformAdId: z.string().optional(),
  createdBy: z.enum(["ui", "agent"]).default("agent"),
});

/**
 * `POST /api/social/ad-links` — record one piece <-> provider-ad link.
 *
 * Only for an ad that is NOT a boosted post: an ad boosting one of the piece's
 * posts is discovered live from the provider's own
 * `effective_instagram_media_id` filter, so a row for it would duplicate an
 * answer libi already has and lose which post it boosts.
 *
 * The ad itself is never fetched here. Linking records provenance; it does not
 * assert the ad exists, and `GET /api/social/pieces/:id/ads` simply omits a
 * linked id the provider does not return.
 */
export async function POST(req: Request): Promise<Response> {
  return socialRoute("ad-links", async () => {
    const providerId = getSocialSettings().providerId;
    if (!providerId) return NextResponse.json({ error: "no_provider" }, { status: 409 });

    const b = await jsonBody(req, adLinkBodySchema);
    if (!b.ok) return b.res;
    if (!getDb().select({ id: pieces.id }).from(pieces).where(eq(pieces.id, b.data.pieceId)).get()) {
      return NextResponse.json({ error: "piece_not_found" }, { status: 404 });
    }
    insertAdLink({
      providerId,
      providerAdId: b.data.providerAdId,
      platformAdId: b.data.platformAdId ?? null,
      pieceId: b.data.pieceId,
      createdBy: b.data.createdBy,
    });
    navigationEmitter.emit("refresh_query", { queryKey: "social", pieceId: b.data.pieceId });
    return NextResponse.json({ ok: true });
  });
}

import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getSocialSettings } from "@/lib/db/settings";
import { withAdapter } from "@/lib/social/service";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";
import { resolveAccountFacts, setUserTikTokKind } from "@/lib/social/music-facts";
import { isComposablePlatform } from "@/lib/social/catalog";
import { browserOnlyRefusal, crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";
import type { AccountMusicFacts } from "@/lib/social/music-policy";

export const dynamic = "force-dynamic";

/** Every active Instagram/TikTok account's music facts; unknown ones are probed
 *  now (D-H in the plan: libi never sees a connect, so this IS "on connect"),
 *  and so is a detected negative, whatever its age — a user who reconnected
 *  through Facebook Login or the Business app sees it on reload.
 *  The probe calls Zernio on the user's grant and stores what it finds, so
 *  another site's request is refused. */
export async function GET(req: Request): Promise<Response> {
  const refused = crossSiteSubresourceRefusal(req);
  if (refused) {
    logger.warn({ tag: "social-music", op: "facts_get_refused", reason: refused }, "refused a cross-site request for the accounts' music facts");
    return NextResponse.json({ error: "The accounts' music facts are read only on libi's own page.", code: "cross_site_read" }, { status: 403 });
  }
  return socialRoute("music.facts.get", async () => {
    const providerId = getSocialSettings().providerId!;
    const facts: Record<string, AccountMusicFacts> = {};
    await withAdapter(async (a) => {
      for (const acc of (await a.listAccounts()).filter((x) => x.active && isComposablePlatform(x.platform))) {
        facts[acc.id] = await resolveAccountFacts(a, providerId, acc, { recheckNegative: true });
      }
    });
    return NextResponse.json({ facts });
  });
}

const putSchema = z.object({ accountId: z.string().min(1), tiktokKind: z.enum(["business", "personal"]) });

/** The user's TikTok account type (a user setting: browser-only, like the other settings). */
export async function PUT(req: Request): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "social-music", op: "facts_put_refused", reason: refused }, "account type change refused: not from libi's own page");
    return NextResponse.json({ error: "The account type is changed only on libi's own page.", code: "browser_only" }, { status: 403 });
  }
  return socialRoute("music.facts.put", async () => {
    const b = await jsonBody(req, putSchema);
    if (!b.ok) return b.res;
    const providerId = getSocialSettings().providerId!;
    const facts = setUserTikTokKind(providerId, b.data.accountId, b.data.tiktokKind);
    navigationEmitter.emit("refresh_query", { queryKey: "social" });
    return NextResponse.json({ facts: { [b.data.accountId]: facts } });
  });
}

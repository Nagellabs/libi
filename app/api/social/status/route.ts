import { NextResponse } from "next/server";
import { getSocialService } from "@/lib/social/service";
import { SOCIAL_PROVIDER_CATALOG } from "@/lib/social/catalog";
import { getSocialSettings } from "@/lib/db/settings";
import { socialRoute } from "@/lib/social/route-helpers";

export const dynamic = "force-dynamic";

/**
 * `SocialStatus` plus the closed catalog (never libi's own token) and the
 * user's social settings, in one call — the Social page's landing read.
 * `status()` is what guarantees no token can ride along: it is the non-secret
 * view (`lib/social/service.ts`), never `readSecret()`.
 */
export async function GET(): Promise<Response> {
  return socialRoute("status", async () => {
    const st = await getSocialService().status();
    return NextResponse.json({
      ...st,
      catalog: SOCIAL_PROVIDER_CATALOG.map((p) => ({ id: p.id, name: p.name, docsUrl: p.docsUrl, dashboardUrl: p.dashboardUrl })),
      settings: getSocialSettings(),
    });
  });
}

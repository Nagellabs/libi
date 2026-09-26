import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getSocialSettings, setSocialSettings } from "@/lib/db/settings";
import { getSocialService } from "@/lib/social/service";
import { navigationEmitter } from "@/lib/navigation-events";
import { trackServerEvent } from "@/lib/analytics/server";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  providerId: z.enum(["zernio"]).nullable(),
  timezone: z.string().min(1).nullable(),
  defaults: z.object({ instagramType: z.enum(["reel", "feed", "story"]), aiLabel: z.boolean() }),
  pollSeconds: z.literal(30),
});

export async function GET(): Promise<Response> {
  return socialRoute("settings.get", async () => NextResponse.json(getSocialSettings()));
}

/**
 * Replace the social settings wholesale. Switching provider drops the held
 * adapter (`reset()`, not `disconnect()` — no grant changed, just which
 * provider's grant is in play) so the next call opens a client for the new
 * choice instead of serving the old provider's connection.
 *
 * Takes the browser-only checks (`browserOnlyRefusal`): these are the user's
 * settings — the provider, and the defaults the composer seeds every new post
 * from (`aiLabel` among them) — so an agent's shell must not rewrite them with
 * a header-less curl. The page's Social settings are the product caller; the
 * skill-eval harness and scripts/qa-social.js stand in for the user and send
 * the page's headers.
 */
export async function PUT(req: Request): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "social", op: "settings.put_refused", reason: refused }, "social settings change refused: not from libi's own page");
    return NextResponse.json({ error: "Social settings are changed only on libi's own page.", code: "browser_only" }, { status: 403 });
  }
  return socialRoute("settings.put", async () => {
    const b = await jsonBody(req, bodySchema);
    if (!b.ok) return b.res;
    const before = getSocialSettings();
    setSocialSettings(b.data);
    if (before.providerId !== b.data.providerId) {
      getSocialService().reset();
      trackServerEvent("social_provider_selected", { provider: b.data.providerId ?? "none" });
    }
    navigationEmitter.emit("refresh_query", { queryKey: "social" });
    return NextResponse.json(getSocialSettings());
  });
}

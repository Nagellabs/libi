import { NextResponse } from "next/server";
import { getSocialSettings } from "@/lib/db/settings";
import { navigationEmitter } from "@/lib/navigation-events";
import { disconnect } from "@/lib/social/oauth/flow";
import { getSocialService } from "@/lib/social/service";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

export const dynamic = "force-dynamic";

/** Remove libi's own grant locally. This is half of a disconnect — the user
 *  revokes libi at the provider too, which the Social page links out to; the
 *  copy there says so. Disconnecting is the user's, from libi's own page
 *  (`browserOnlyRefusal`). */
export async function POST(req: Request): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "social", op: "oauth.disconnect_refused", reason: refused }, "social disconnect refused: not from libi's own page");
    return NextResponse.json({ error: "Social accounts are disconnected only on libi's own page.", code: "browser_only" }, { status: 403 });
  }
  const { providerId } = getSocialSettings();
  if (!providerId) return NextResponse.json({ error: "no_provider" }, { status: 409 });
  disconnect(providerId);
  // `disconnect()`, not `reset()`: the grant is GONE, so the held client must
  // close for good rather than be reopened by the next request. A later
  // sign-in comes back through the callback, which resets.
  getSocialService().disconnect();
  navigationEmitter.emit("refresh_query", { queryKey: "social" });
  return NextResponse.json({ ok: true });
}

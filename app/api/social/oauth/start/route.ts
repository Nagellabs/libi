import { NextResponse } from "next/server";
import { getSocialSettings } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { errShape } from "@/lib/social/errors";
import { browserOnlyRefusal } from "@/lib/security/request-guard";
import { startSignIn } from "@/lib/social/oauth/flow";

export const dynamic = "force-dynamic";

/**
 * Begin libi's own sign-in with the chosen social provider. The answer is the
 * authorization URL for the page to open — never a token, and never anything
 * the SDK obtained on the way there.
 *
 * The studio port comes off this very request, because that is the port the
 * callback has to come back to: the redirect is `127.0.0.1:<that port>`, and
 * under the packaged app the port is ephemeral, so a remembered one would be
 * wrong on the next launch.
 *
 * Connecting an account is the user's, from libi's own page
 * (`browserOnlyRefusal`): a header-less loopback caller is refused.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = browserOnlyRefusal(request);
  if (refused) {
    logger.warn({ tag: "social", op: "oauth.start_refused", reason: refused }, "social sign-in refused: not from libi's own page");
    return NextResponse.json({ error: "Social accounts are connected only on libi's own page.", code: "browser_only" }, { status: 403 });
  }
  const { providerId } = getSocialSettings();
  if (!providerId) return NextResponse.json({ error: "no_provider" }, { status: 409 });

  const port = Number(new URL(request.url).port || 80);
  if (!Number.isInteger(port) || port <= 0) {
    logger.error({ tag: "social", op: "oauth.start_failed", providerId }, "no studio port on the request");
    return NextResponse.json({ error: "start_failed" }, { status: 502 });
  }

  try {
    // Nothing is invalidated here: the grant has not changed yet, and this
    // sign-in may never complete. Whatever is cached against the CURRENT
    // grant is still correct until the callback replaces it (or disconnect
    // removes it), which is where `getSocialService().reset()` is called —
    // dropping a live provider client at the moment the user clicks Connect
    // would break a session that is working.
    const { url } = await startSignIn(providerId, port);
    return NextResponse.json({ url });
  } catch (err) {
    // NAME AND CODE ONLY. The SDK builds `… Raw body: <body>` for any
    // non-OAuth-shaped error from the registration or token endpoint, and the
    // request that provoked it carried the PKCE verifier — see `errShape`.
    logger.error(
      { tag: "social", op: "oauth.start_failed", providerId, ...errShape(err) },
      "sign-in could not start",
    );
    return NextResponse.json({ error: "start_failed" }, { status: 502 });
  }
}

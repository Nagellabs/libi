import { NextResponse } from "next/server";
import { getSocialSettings } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { errShape } from "@/lib/social/errors";
import { browserOnlyRefusal } from "@/lib/security/request-guard";
import { startSignIn } from "@/lib/social/oauth/flow";
import { getCurrentPort } from "@/lib/libi-home";

export const dynamic = "force-dynamic";

/**
 * Begin libi's own sign-in with the chosen social provider. The answer is the
 * authorization URL for the page to open — never a token, and never anything
 * the SDK obtained on the way there.
 *
 * The callback has to come back to the port this studio is serving on — the
 * redirect is `127.0.0.1:<that port>` — so it is read from `getCurrentPort()`:
 * `LIBI_SERVER_PORT`, which Category B publishes from the port actually bound,
 * this launch. The same source the refresh path uses (`lib/social/service.ts`).
 *
 * NEVER from `request.url`. libi's production servers (packaged
 * `lib/server/next-server.ts`, npx `lib/cli/studio.ts`) are custom servers,
 * and Next synthesizes a handler's `request.url` from the port and hostname it
 * was CONSTRUCTED with, falling back to `localhost:3000` — not the socket the
 * request arrived on. Reading the port off it sent every packaged and npx
 * sign-in back to `127.0.0.1:3000`, a refused connection (SOC-3, 0.1.16); only
 * `next dev`, which passes its real port, ever worked. A remembered port would
 * be wrong too: the packaged port is ephemeral.
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

  let port: number;
  try {
    port = getCurrentPort();
  } catch {
    port = NaN;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    logger.error({ tag: "social", op: "oauth.start_failed", providerId }, "studio port unknown");
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

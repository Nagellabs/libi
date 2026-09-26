import { trackServerEvent } from "@/lib/analytics/server";
import { serverLogger as logger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import { errShape } from "@/lib/social/errors";
import { cancelSignIn, finishSignIn, PENDING_SIGN_IN_TTL_MS, SignInWindowExpiredError } from "@/lib/social/oauth/flow";
import { getSocialService } from "@/lib/social/service";

export const dynamic = "force-dynamic";

/** The tab the user is sitting in, so HTML rather than JSON. Every string here
 *  is a literal of ours — nothing from the query is ever reflected into it,
 *  which is both an XSS rule and the reason no code or state can end up on a
 *  page the user might screenshot or share. */
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh">` +
  `<div><h1 style="font-size:18px">${title}</h1><p>${body}</p></div>`;

const html = (title: string, body: string, status = 200) =>
  new Response(page(title, body), { status, headers: { "content-type": "text/html; charset=utf-8" } });

/**
 * Where the provider sends the browser back. The `state` is checked against
 * the sign-in that started it before the code is used for anything; an
 * unknown, expired or replayed one gets the same refusal as an outright
 * forgery, and stores nothing.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");

  if (error || !code || !state) {
    // The user declined, or the provider bounced us. Shut this sign-in's
    // window now instead of leaving it answerable for the rest of its TTL.
    cancelSignIn(state);
    return html("Sign-in cancelled", "You can close this tab and try again from libi.", 400);
  }

  try {
    const { providerId } = await finishSignIn({ code, state });
    getSocialService().reset();
    navigationEmitter.emit("refresh_query", { queryKey: "social" });
    trackServerEvent("social_libi_connected", { provider: providerId });
    return html("libi is connected", "You can close this tab and go back to libi.");
  } catch (err) {
    // NAME AND CODE ONLY — the message from a failed exchange can carry the
    // token endpoint's raw body back, and the request that produced it held
    // the authorization `code` and the PKCE `code_verifier` (see `errShape`).
    logger.error(
      { tag: "social", op: "oauth.callback_failed", ...errShape(err) },
      "sign-in could not finish",
    );
    // An expired window is not a fault, and saying "failed" sends the user
    // looking for one (QA 2026-09-21, finding 11). The server knows which it
    // is, so it says which — still a literal of ours, still nothing from the
    // query reflected into the page, and still nothing stored either way.
    return err instanceof SignInWindowExpiredError
      ? html(
          "Sign-in window expired",
          `This sign-in was started more than ${Math.round(PENDING_SIGN_IN_TTL_MS / 60_000)} minutes ago, so libi stopped waiting for it. Nothing went wrong and nothing was changed — go back to libi and click Connect again.`,
          400,
        )
      : html("Sign-in failed", "Go back to libi and try Connect again.", 400);
  }
}

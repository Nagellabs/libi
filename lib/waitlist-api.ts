/**
 * Client for the marketing site's waitlist endpoint.
 *
 * The address is POSTed to `POST {SITE_URL}/api/waitlist`, which validates it
 * again server-side and writes one document to Firestore — `libi-prod` for the
 * production site, `libi-dev` for a preview or local one. The route lives in
 * the libi-site repo (`app/api/waitlist/route.ts`); its setup and the exact
 * document shape are documented in that repo's `docs/waitlist-firebase-setup.md`.
 *
 * Consent is the submission itself: typing an address into a form headed "Join
 * waitlist" and pressing the button is an unambiguous affirmative act for a
 * single, stated purpose. What carries the weight is the notice rendered next
 * to the button — WaitlistCard's NOTICE — which says where the address goes and
 * what it is used for BEFORE it is sent. Keep that notice truthful and visible;
 * it is the disclosure privacy policy §5.3 describes.
 */

import { SITE_URL } from "@/lib/site-url";

export interface WaitlistSubmitResult {
  ok: boolean;
  /** Present when `ok` is false. Safe to show to the user verbatim. */
  error?: string;
}

/**
 * Submit an address to the waitlist.
 *
 * Never throws — a network failure comes back as `{ ok: false, error }` so the
 * caller has one path to render. The messages distinguish "your input was
 * wrong" from "we couldn't reach the server", because retrying helps in exactly
 * one of those cases.
 */
export async function submitWaitlistSignup(
  email: string,
  plan: string,
  appVersion?: string | null,
): Promise<WaitlistSubmitResult> {
  let response: Response;
  try {
    response = await fetch(`${SITE_URL}/api/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        plan,
        ts: new Date().toISOString(),
        source: "editor",
        // The running @nagellabs/libi runtime version, when the shell has
        // resolved one. Omitted rather than sent as null so the field is
        // absent — the server stores null either way.
        ...(appVersion ? { appVersion } : {}),
      }),
    });
  } catch {
    return {
      ok: false,
      error: "Couldn't reach the server. Check your connection and try again.",
    };
  }

  if (response.ok) return { ok: true };

  // The route answers with { ok, error } on every failure it generates itself.
  // A proxy or an unexpected 5xx may not, so fall back rather than surfacing
  // "undefined" or a chunk of someone's HTML error page.
  let message: string | undefined;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    /* not JSON — use the fallback below */
  }

  return {
    ok: false,
    error:
      message ??
      (response.status >= 500
        ? "The waitlist is temporarily unavailable. Please try again later."
        : "Couldn't join the waitlist. Please try again."),
  };
}

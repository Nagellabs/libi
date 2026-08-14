/**
 * The marketing site's origin — the one place the app decides where
 * https://libi.nagellabs.com lives.
 *
 * Two things depend on it and must not drift apart: the published legal
 * documents (lib/legal-links.ts) and the waitlist endpoint the app POSTs to
 * (lib/waitlist-api.ts). Pointing one at staging and leaving the other on
 * production is exactly the mistake a single constant prevents.
 *
 * Override with NEXT_PUBLIC_LIBI_SITE_URL when running against a staging site.
 */

export const SITE_URL = (
  process.env.NEXT_PUBLIC_LIBI_SITE_URL ?? "https://libi.nagellabs.com"
).replace(/\/+$/, "");

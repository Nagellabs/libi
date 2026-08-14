/**
 * Canonical URLs for libi's legal documents.
 *
 * The documents themselves live in the MARKETING SITE — its own repo,
 * https://github.com/Nagellabs/libi-site (`lib/legal-content.ts`, rendered by
 * `app/{privacy,terms,accessibility}`) — deliberately, not in this app.
 *
 * That split matters: legal text has to be correctable on its own schedule. A policy fix
 * should be a site deploy, not something a user only receives when they next update the
 * desktop app (or never, if they pin a version). So the app never embeds a copy — it links
 * out to the published, always-current page.
 *
 * The origin itself lives in lib/site-url.ts, shared with the waitlist endpoint so the
 * two cannot end up pointing at different deployments. Override it with
 * NEXT_PUBLIC_LIBI_SITE_URL when running against a staging site.
 */

import { SITE_URL } from "@/lib/site-url";

export const LEGAL_LINKS = {
  privacy: `${SITE_URL}/privacy`,
  terms: `${SITE_URL}/terms`,
  accessibility: `${SITE_URL}/accessibility`,
  license: "https://github.com/Nagellabs/libi/blob/main/LICENSE",
} as const;

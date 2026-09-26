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

/**
 * The links of the site at `origin`. A dev build switched to a development
 * templates catalog links that site's own Terms and Privacy (the text under
 * test); otherwise production's — see `useLegalLinks`
 * (lib/queries/templates-catalog.ts), which components use.
 */
export function legalLinksFor(origin: string) {
  return {
    privacy: `${origin}/privacy`,
    terms: `${origin}/terms`,
    /** The Terms' section on publishing to the public templates catalog (§4A). */
    templatesCatalogTerms: `${origin}/terms#templates-catalog`,
    /**
     * The site's no-account report form (libi-site app/templates/report), with
     * the template prefilled: where a formal copyright notice goes, since the
     * in-app report carries no contact details or claimant statement.
     */
    templateReportForm: (cloudId: string) => `${origin}/templates/report?template=${encodeURIComponent(cloudId)}`,
    /** How an author disputes a takedown (Terms §11). */
    templatesDispute: `${origin}/terms#copyright`,
    accessibility: `${origin}/accessibility`,
    license: "https://github.com/Nagellabs/libi/blob/main/LICENSE",
  } as const;
}
export type LegalLinks = ReturnType<typeof legalLinksFor>;

/** The build's own site's links: what a packaged build shows, and the fallback before the catalog view has loaded. */
export const LEGAL_LINKS: LegalLinks = legalLinksFor(SITE_URL);

/**
 * The rules for a DEVELOPMENT templates catalog's address and its Vercel
 * protection-bypass token — pure, no Node or DB import, so the Settings card
 * (a client component) checks exactly what the server enforces
 * (lib/templates/cloud/catalog-setting.ts).
 *
 * A dev build can read the production catalog or a development site: the
 * owner's local libi-site (`http://localhost:3300`) or a Vercel preview of it
 * (`https://libi-site-git-<branch>-<team>.vercel.app`). Previews are behind
 * Vercel's Deployment Protection, so requests to one carry the project's
 * "Protection Bypass for Automation" secret — to that exact origin and
 * nowhere else. `*.vercel.app` is every Vercel user's domain, so the token is
 * bound to the origin it was entered for: a different origin needs it again.
 */
import { PRODUCTION_SITE_URL } from "@/lib/site-url";
import { TEST_MODE_SOURCE } from "@/lib/templates/cloud/constants";
import type { TemplatesCatalogActive } from "@/lib/templates/types";

/** The header Vercel reads the bypass secret from. */
export const VERCEL_BYPASS_HEADER = "x-vercel-protection-bypass";

/**
 * A bypass secret as Vercel mints them (32 alphanumerics today), with room to
 * spare. Never shorter than 16: that is also the floor below which the
 * logger's live-secret mask (lib/security/secret-scrub.ts) ignores a value.
 */
export const BYPASS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export type DevOriginResult = { ok: true; origin: string } | { ok: false; error: string };

/**
 * A development catalog's address, reduced to its origin. `https://` any
 * host, or `http://` to localhost / 127.0.0.1 only (the site running on this
 * machine). Never credentials, and never the production site itself — that is
 * the Production choice, not a development one.
 */
export function parseDevOrigin(raw: string): DevOriginResult {
  const text = raw.trim();
  if (!text) return { ok: false, error: "Enter the development site's address." };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: "That isn't a web address. Paste it with https://." };
  }
  if (u.username || u.password) return { ok: false, error: "The address can't carry a user name or password." };
  // Longer than a valid DNS host ever is, and past what the desktop shell's native
  // confirm dialog will render (CATALOG_HOST_MAX_CHARS, electron/confirm-publish.ts) —
  // refused here, at the address, rather than surfacing as a "refused" confirm later.
  if (u.host.length > 253) return { ok: false, error: "That address is too long for a web address." };
  if (u.protocol === "http:") {
    if (!LOCAL_HOSTS.has(u.hostname)) return { ok: false, error: "Only a site on this machine (localhost or 127.0.0.1) may use http://; anything else needs https://." };
  } else if (u.protocol !== "https:") {
    return { ok: false, error: "The address must start with https:// (or http://localhost)." };
  }
  // The production site in ANY spelling — case, a trailing dot (or its %2e),
  // a default or other port — is the Production choice: taken as a
  // "development" one it would publish to production as a throwaway link.
  if (isProductionHost(u.hostname)) return { ok: false, error: "That's the production catalog — choose Production instead." };
  return { ok: true, origin: u.origin };
}

const PRODUCTION_HOST = new URL(PRODUCTION_SITE_URL).hostname;

/** Whether `hostname` names the production site: case-insensitive, trailing dots ignored. */
function isProductionHost(hostname: string): boolean {
  return hostname.toLowerCase().replace(/\.+$/, "") === PRODUCTION_HOST;
}

/** Whether `origin` is a Vercel deployment (`https://*.vercel.app`), the only kind a bypass token is ever sent to. */
export function isVercelPreviewOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && u.origin === origin && u.hostname.endsWith(".vercel.app") && u.hostname.length > ".vercel.app".length;
  } catch {
    return false;
  }
}

/** The host a catalog is named by in the UI (`localhost:3300`, `libi.nagellabs.com`). */
export function catalogHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** A catalog source (`catalogSource()`: "test-mode" or a site origin) as the UI names it. */
export function describeCatalogSource(source: string): TemplatesCatalogActive {
  if (source === TEST_MODE_SOURCE) return { kind: "test-mode", origin: null, host: null };
  return { kind: source === PRODUCTION_SITE_URL ? "production" : "development", origin: source, host: catalogHost(source) };
}

/**
 * Server-side client for the marketing site's announcements endpoint
 * (`GET {SITE_URL}/api/announcements`, libi-site repo). Never throws — an
 * offline machine or a down site means "no announcements", not an error.
 *
 * Successful responses are cached in module memory for 5 minutes; failures
 * are NOT cached (the query layer polls every 6 h, so there is no hammering
 * to protect against, and a transient failure shouldn't blank the banner for
 * 5 minutes at launch).
 */

import { SITE_URL } from "@/lib/site-url";
import { serverLogger as logger } from "@/lib/logger";

export interface SiteAnnouncement {
  id: string;
  title: string;
  body: string;
  kind: "feature" | "issue";
  url: string | null;
  createdAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

let cache: { at: number; announcements: SiteAnnouncement[] } | null = null;

/** Test seam. */
export function clearAnnouncementsCache(): void {
  cache = null;
}

/** Keep only http(s) URLs — mirrors the site's own rule (docs/announcements.md), but
 * the app is the one rendering this as a link, so it validates independently rather
 * than trusting the site to have enforced it. */
function shapeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function shape(entry: unknown): SiteAnnouncement | null {
  if (typeof entry !== "object" || entry === null) return null;
  const raw = entry as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const title = typeof raw.title === "string" ? raw.title : "";
  const body = typeof raw.body === "string" ? raw.body : "";
  if (!title && !body) return null;
  if (typeof raw.createdAt !== "string") return null;
  return {
    id: raw.id,
    title,
    body,
    kind: raw.kind === "issue" ? "issue" : "feature",
    url: shapeUrl(raw.url),
    createdAt: raw.createdAt,
  };
}

export async function fetchLiveAnnouncements(): Promise<SiteAnnouncement[]> {
  const now = Date.now();
  // Defensive copy is array-level only (elements are shared with the cache) — fine
  // because no consumer mutates an individual SiteAnnouncement.
  if (cache && now - cache.at < CACHE_TTL_MS) return [...cache.announcements];

  try {
    const response = await fetch(`${SITE_URL}/api/announcements`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      logger.debug(
        { tag: "announcements", op: "fetch-non-ok", status: response.status },
        "announcements endpoint answered non-200",
      );
      return [];
    }
    const json = (await response.json()) as { announcements?: unknown };
    const list = Array.isArray(json?.announcements)
      ? json.announcements.map(shape).filter((a): a is SiteAnnouncement => a !== null)
      : [];
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    cache = { at: now, announcements: list };
    return [...list];
  } catch (error) {
    // Offline is a normal state for a desktop app, not an error.
    logger.debug(
      { tag: "announcements", op: "fetch-failed", error: String(error) },
      "could not reach announcements endpoint",
    );
    return [];
  }
}

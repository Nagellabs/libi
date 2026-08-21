/**
 * Where the onboarding piece's media is downloaded from — and, inseparably,
 * which SSRF guard those downloads are vetted with.
 *
 * The two are resolved together on purpose. The guard is chosen by WHERE THE
 * BASE URL CAME FROM, never by what the URL looks like:
 *
 *   - no env var  → the public GCS bucket → `assertPublicHttpUrl`, always.
 *   - `LIBI_ONBOARDING_ASSET_BASE` set → that base →
 *     `assertDevLoopbackOrPublicHttpUrl`, which additionally permits loopback
 *     on any port so a test or a staging box can serve fixtures from an
 *     ephemeral local server.
 *
 * Deciding from the shape of the URL instead ("it's loopback, so relax the
 * guard") would mean a released build with no env var set could reach the
 * relaxed guard for any URL that merely resolves to a private address. There
 * is deliberately no such code path: the default and the strict guard are
 * returned from the same branch, so one cannot be swapped without the other.
 */

import type { UrlGuard } from "@/lib/net/follow-redirects";
import {
  assertDevLoopbackOrPublicHttpUrl,
  assertPublicHttpUrl,
} from "@/lib/net/url-guard";

/** Public, unauthenticated bucket prefix. Versioned directories live under it. */
export const DEFAULT_ONBOARDING_ASSET_BASE =
  "https://storage.googleapis.com/libi-public-assets/onboarding";

/** Overrides the base for tests and staging. Setting it — and only setting it
 *  — is what relaxes the guard. */
export const ONBOARDING_ASSET_BASE_ENV = "LIBI_ONBOARDING_ASSET_BASE";

export interface AssetSource {
  /** Fully-qualified base for this version, no trailing slash. */
  baseUrl: string;
  /** The guard every URL from this base must pass. */
  guard: UrlGuard;
  /** True when LIBI_ONBOARDING_ASSET_BASE overrode the default. */
  overridden: boolean;
}

/** Drop leading/trailing slashes so joining can't produce `//` or `/`-less. */
function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, "");
}

/**
 * A version directory or an asset slug is ONE path segment: it starts
 * alphanumeric and holds only `[a-z0-9._-]`. Both are compile-time constants
 * today, which is exactly why this is asserted rather than assumed —
 * `trimSlashes` alone strips only the outer slashes, so `"../.."` would
 * survive it and quietly rebase every download on the bucket root.
 */
const PATH_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

function assertPathSegment(what: string, value: string): string {
  const trimmed = trimSlashes(value);
  if (!PATH_SEGMENT.test(trimmed)) {
    throw new Error(
      `invalid onboarding asset ${what}: ${JSON.stringify(value)} — ` +
        `must be one path segment matching ${PATH_SEGMENT}`,
    );
  }
  return trimmed;
}

/**
 * Resolve the base URL for `version` (e.g. `"v1"`) together with the guard
 * that every download from it must pass. Read fresh on every call — the env
 * var is a test/staging switch, not a boot-time constant.
 */
export function resolveAssetSource(version: string): AssetSource {
  const raw = process.env[ONBOARDING_ASSET_BASE_ENV]?.trim();
  const overridden = Boolean(raw);
  const base = overridden ? (raw as string) : DEFAULT_ONBOARDING_ASSET_BASE;

  if (overridden) {
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new Error(
        `${ONBOARDING_ASSET_BASE_ENV} is not a valid http(s) url: ${base}`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `${ONBOARDING_ASSET_BASE_ENV} must be an http(s) url, got ${parsed.protocol}//… (${base})`,
      );
    }
  }

  return {
    baseUrl: `${base.replace(/\/+$/, "")}/${assertPathSegment("version", version)}`,
    // The ONE place the relaxed guard is reached from, and only on the
    // env-overridden branch. See `assertDevLoopbackOrPublicHttpUrl`'s note.
    guard: overridden ? assertDevLoopbackOrPublicHttpUrl : assertPublicHttpUrl,
    overridden,
  };
}

/** URL of one asset by slug. Slugs are plain filenames (see `types.ts`). */
export function assetUrl(source: AssetSource, slug: string): string {
  return `${source.baseUrl}/${assertPathSegment("slug", slug)}`;
}

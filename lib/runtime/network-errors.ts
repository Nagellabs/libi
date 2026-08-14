// lib/runtime/network-errors.ts
//
// "Is this failure the network being unreachable, and if so, WHICH host?"
//
// libi's install paths depend on at least three hosts that fail independently:
//
//   * the npm registry (`registry.npmjs.org`, or a private/local override)
//   * `github.com` — where `prebuild-install` fetches better-sqlite3's native
//     binding from, and where several bundled binaries (ffmpeg, yt-dlp, …) are
//     released
//   * `electronjs.org` — Electron headers, for the prebuild target
//
// A user behind a corporate proxy typically has npm working through an internal
// mirror while `github.com` is blocked outright. "Something went wrong" costs
// them a support round-trip; "github.com is unreachable" lets them self-
// diagnose in seconds. So every install-failure message that CAN name a host
// does.
//
// Kept dependency-free and separate from both consumers
// (`lib/server/lifecycle/install-error-hints.ts` and
// `lib/runtime/runtime-install.ts`) so the classification cannot drift between
// the Category-A path and the runtime-fetch path.

/**
 * Does this error text indicate the network could not be reached, as opposed to
 * a 404, an auth failure, a disk problem, or a genuine package error?
 *
 * Deliberately conservative. A false positive tells a user to check their proxy
 * when the real problem is elsewhere, which is worse than the generic message —
 * so only unambiguous transport-level failures match.
 */
export function looksUnreachable(message: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_SOCKET_TIMEOUT|network timeout|getaddrinfo|tunneling socket could not be established|socket hang up|self[- ]signed certificate|unable to (?:verify|get) local issuer/i.test(
    message,
  );
}

/**
 * Best-effort host to blame, pulled from whatever URL or `getaddrinfo` target
 * the error text carries. Returns null when nothing is quotable — in which case
 * the caller must NOT invent one.
 */
export function extractUnreachableHost(message: string): string | null {
  const url = /https?:\/\/([A-Za-z0-9.\-_]+)(?::\d+)?/.exec(message);
  if (url) return url[1];
  // `getaddrinfo ENOTFOUND registry.npmjs.org`
  const dns = /(?:ENOTFOUND|EAI_AGAIN)\s+([A-Za-z0-9.\-_]+)/.exec(message);
  if (dns) return dns[1];
  return null;
}

/**
 * The one support channel that actually exists today.
 *
 * NOT `https://github.com/Nagellabs/libi/issues` (README.md:121): the
 * repository is still private, so that URL 404s for every outside user, and a
 * dead link on a failure screen is worse than no link at all.
 * `support@nagellabs.com` is the address CONTRIBUTING.md already publishes for
 * general questions. Swap this for the issues URL once the repo is public.
 */
export const SUPPORT_CONTACT = "support@nagellabs.com";

/** One-line support footer for a user-facing failure message. */
export const SUPPORT_LINE = `Need help? ${SUPPORT_CONTACT}`;

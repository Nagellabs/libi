import { agentSetupHref } from "@/lib/agents/setup/registry";

/**
 * A user who never answered the persona question is sent to the Agents tab from
 * wherever they were going (`FirstLaunchGate`), and goes back there once they
 * answer (`PersonaModal`). The place to go back to travels in this query param.
 */
export const RETURN_TO_PARAM = "returnTo";

/**
 * Where a first launch goes from `current` (the editor's location). The plain
 * editor a launch opens is not a deep link — the Agents tab is where that user
 * belongs — so only a location with a query is carried along.
 */
export function firstLaunchHref(current: { pathname: string; search: string }): string {
  const setup = agentSetupHref();
  if (current.search === "" || current.search === "?") return setup;
  return `${setup}&${RETURN_TO_PARAM}=${encodeURIComponent(current.pathname + current.search)}`;
}

/**
 * The only shape followed: exactly `/`, or `/` and then anything but another
 * slash or a backslash. Browsers resolve `//host` and `/\host` to another host.
 */
const APP_PATH = /^\/(?![/\\])/;
/** Backslashes, whitespace, control and invisible formatting characters: browsers drop or reinterpret several, and no app path has one. */
const UNSAFE_CHARACTER = /[\\\s\p{Cc}\p{Cf}]/u;
/** Layers of percent-encoding undone before a path counts as too murky to follow. */
const MAX_DECODES = 4;

function isAppPath(path: string): boolean {
  return APP_PATH.test(path) && !UNSAFE_CHARACTER.test(path);
}

/** `path` resolved on `origin` — dot-segments and all — as pathname + search + hash; null if it leaves `origin` or isn't an app page. */
function resolvedAppPath(path: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname === "/api" || url.pathname.startsWith("/api/")) return null;
  const resolved = url.pathname + url.search + url.hash;
  return isAppPath(resolved) ? resolved : null;
}

/** `path` with every layer of percent-encoding undone; null when malformed, or still encoded after `MAX_DECODES`. */
function fullyDecoded(path: string): string | null {
  let current = path;
  for (let i = 0; i <= MAX_DECODES; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null;
}

/**
 * `value` as a path to navigate to, when it is one of this app's own pages on
 * `origin`; otherwise null. The value comes from a URL anyone can craft, so what
 * is checked is what gets RETURNED: the path after the URL parser resolves its
 * dot-segments (`/.//host` becomes `//host`), and again with its path's
 * percent-encoding undone (`/%2F%2Fhost`, `/%5Chost`). Either one must be an app
 * path on `origin`. Another origin, a scheme, backslashes, whitespace, control
 * characters and the API routes are all refused.
 */
export function safeReturnPath(value: string | null, origin: string): string | null {
  if (value === null || !isAppPath(value)) return null;
  const resolved = resolvedAppPath(value, origin);
  if (resolved === null) return null;

  // Only the path is decoded: an encoded slash in the query is part of a value.
  const pathEnd = value.search(/[?#]/);
  const decoded = fullyDecoded(pathEnd === -1 ? value : value.slice(0, pathEnd));
  // A decoded `?` or `#` would restart the URL parser's own split into query/hash,
  // hiding whatever comes after from this check — no app route encodes either in
  // its path, so treat one turning up after decoding as disqualifying.
  if (
    decoded === null ||
    decoded.includes("?") ||
    decoded.includes("#") ||
    !isAppPath(decoded) ||
    resolvedAppPath(decoded, origin) === null
  )
    return null;

  return resolved;
}

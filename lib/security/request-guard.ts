const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function isSafeMethod(method: string): boolean {
  return SAFE.has(method.toUpperCase());
}

function hostname(host: string | null): string | null {
  if (!host) return null;
  // strip port; handle IPv6 [::1]:port
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0];
}

export function isLoopbackHost(host: string | null): boolean {
  const h = hostname(host);
  return h != null && LOOPBACK.has(h);
}

// A loopback authority in full — hostname AND port, nothing else. `isLoopbackHost`
// above deliberately looks only at the hostname, which is the right question for
// the CSRF/DNS-rebinding gate (it never echoes the value anywhere). It is the
// WRONG question wherever the Host header is interpolated into a response: a
// header value may legally carry spaces, quotes and semicolons, so
// `127.0.0.1:1; frame-ancestors *` and `127.0.0.1:1"><x>` both satisfy
// `isLoopbackHost` and would otherwise land verbatim inside the overlay runtime
// page's Content-Security-Policy and its `<script src>` attribute.
const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/;

/**
 * The request's Host header when — and only when — it is a well-formed loopback
 * authority; otherwise `null`. Callers that EMIT the host (the overlay runtime
 * page and the CSP the proxy puts on it) must use this rather than
 * `isLoopbackHost`, so nothing a request supplies can shape a security header or
 * an HTML attribute. The value is returned verbatim, so it is safe to
 * interpolate as `http://${authority}`.
 */
export function parseLoopbackAuthority(host: string | null): string | null {
  if (!host) return null;
  return LOOPBACK_AUTHORITY.test(host) ? host : null;
}

export function evaluateRequestOrigin(input: {
  method: string;
  secFetchSite: string | null;
  host: string | null;
  origin: string | null;
  serverHost: string | null;
}): { allow: boolean; reason: string } {
  // DNS-rebinding gate, on EVERY method: the server binds only 127.0.0.1, so
  // every legitimate request — Electron, a browser at 127.0.0.1/localhost, the
  // internal MCP-child Node client — carries a loopback Host header. A page
  // that rebinds its own hostname to 127.0.0.1 is same-origin to the browser,
  // so `Sec-Fetch-Site: same-origin` and Origin/Host/serverHost all name the
  // attacker's domain (and pass the origin-vs-serverHost check below, since
  // serverHost is the same Host header) — only the Host itself gives it away.
  // Reads leak as much as writes do (the legacy provider key notice, pieces, a
  // template's index.md), so this runs before the safe-method return.
  if (!isLoopbackHost(input.host)) return { allow: false, reason: "non_loopback_host" };

  // A loopback read is allowed whatever Sec-Fetch-Site says: the opaque-origin
  // sandbox, test-mode catalog media at 127.0.0.1 under a localhost page and
  // the PDF viewer all read cross-site legitimately, and a cross-site no-cors
  // read is opaque to the page that made it. A GET with an outside effect
  // refuses those itself — crossSiteSubresourceRefusal below.
  if (isSafeMethod(input.method)) return { allow: true, reason: "safe_method" };

  // An Origin header on a mutation must match this request's own server
  // host:port exactly — a cross-port loopback attacker (localhost:OTHER) is
  // still cross-origin. Malformed Origin is rejected outright.
  if (input.origin) {
    let originHost: string;
    try {
      originHost = new URL(input.origin).host;
    } catch {
      return { allow: false, reason: "bad_origin" };
    }
    if (originHost !== input.serverHost) return { allow: false, reason: "foreign_origin" };
  }

  if (input.secFetchSite != null) {
    const s = input.secFetchSite.toLowerCase();
    if (s === "same-origin" || s === "none") return { allow: true, reason: "same_origin" };
    return { allow: false, reason: "cross_site_fetch" };
  }

  // No Sec-Fetch-Site => non-browser client (internal MCP child, CLI, curl);
  // its loopback Host was checked above.
  return { allow: true, reason: "internal_client" };
}

/**
 * The browser-only checks for a route whose action only the user may take
 * from libi's own page (confirming a publish, revealing the creator key):
 * the request must carry `Sec-Fetch-Site: same-origin` and an `Origin` equal
 * to the studio's own (a well-formed loopback authority, the request's own
 * Host). A browser sets both itself on a same-origin `fetch` POST, and no web
 * page can forge either.
 *
 * NOT authentication. The proxy lets a header-less loopback client through as
 * an "internal client" (every header it checks can be forged by a local
 * process), and so can this: a local program that DELIBERATELY impersonates
 * the browser passes. What it stops is the ordinary path — a tool call, a
 * curl, a script — that never set out to pose as the page. See the
 * LIMITATIONS in lib/approval/extensions.ts.
 */
export function browserOnlyRefusal(req: Request): string | null {
  if (req.headers.get("sec-fetch-site")?.toLowerCase() !== "same-origin") return "not_same_origin_fetch";
  const authority = parseLoopbackAuthority(req.headers.get("host"));
  if (!authority) return "non_loopback_host";
  const origin = req.headers.get("origin");
  if (!origin) return "missing_origin";
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return "bad_origin";
  }
  if (parsed.protocol !== "http:" || parsed.host !== authority || origin !== `http://${authority}`) return "foreign_origin";
  return null;
}

/**
 * A GET's own refusal of a cross-site or same-site SUBRESOURCE request — an
 * `<img src>`, a `<script src>`, a cross-origin `fetch` — from someone else's
 * page: `"cross_site_read"` when `Sec-Fetch-Site` is `cross-site` or
 * `same-site`, navigations included; otherwise `null` (the studio's own
 * same-origin fetch, `none` — a typed URL or a bookmark — and a header-less
 * internal client such as the MCP child or curl). Navigations are refused
 * too: a hidden `<iframe>`, `<object>`, GET form or `window.open` from a
 * stranger's page runs the handler (and its outside effect) before
 * `frame-ancestors` stops the response from rendering, and no legitimate
 * caller reaches these routes by a cross-site navigation.
 *
 * Per route, not in the proxy, because legitimate cross-site reads exist: the
 * opaque-origin sandbox loads `/api/sandbox/runtime-bundle`, test-mode catalog
 * posters and examples load from `127.0.0.1` under a studio opened at
 * `localhost`, and the PDF viewer and media documents run under the media
 * CSP's `sandbox`. A cross-site no-cors read is opaque to the page that makes
 * it anyway, so only a read with an OUTSIDE EFFECT needs this. Any GET that
 * spends the creator key, calls the site, or writes must call it first —
 * today that is `/api/templates/cloud/mine`, `/api/templates/cloud/catalog`,
 * `/api/templates/cloud/catalog/[cloudId]` (a public template's page: it asks
 * the site for the document and downloads its template.json),
 * `/api/templates/cloud/asset-stream` (it fetches a public template's
 * link-only audio or video from the author's host),
 * `/api/templates/cloud/creator` (it asks the site for the creator key's
 * approval to publish, spending the key), and `/api/templates/cloud/author`
 * and `/api/templates/cloud/key` (their GET creates the creator identity on
 * first view).
 *
 * Like browserOnlyRefusal, NOT authentication: a local process sends no
 * Sec-Fetch headers and passes. What it stops is a stranger's web page.
 */
export function crossSiteSubresourceRefusal(req: Request): "cross_site_read" | null {
  const site = req.headers.get("sec-fetch-site")?.toLowerCase();
  if (site !== "cross-site" && site !== "same-site") return null;
  return "cross_site_read";
}

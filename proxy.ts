import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { evaluateRequestOrigin, parseLoopbackAuthority } from "@/lib/security/request-guard";
import { cspForPath } from "@/lib/security/csp";
import { isMediaServingPath } from "@/lib/security/media-paths";
import { MEDIA_RESPONSE_CSP } from "@/lib/http/media-types";

// Next 16 renamed the `middleware` file convention to `proxy` (deprecated `middleware`).
// This runs before matched routes on the Node runtime and is the single chokepoint
// enforcing two security controls:
//
//  1. RC-A: loopback Host on every `/api` request; cross-origin mutations
//     refused. The DNS-rebinding Host check runs on reads too (a rebound page
//     could otherwise read any GET); cross-origin browser mutations (CSRF /
//     text-plain form POSTs) are refused, while same-origin browser requests
//     and the internal MCP-child Node client pass. Cross-site GETs are NOT
//     refused here — a GET with an outside effect refuses them itself
//     (lib/security/request-guard.ts#crossSiteSubresourceRefusal). This applies
//     to `/api/*` ONLY (the app has no Server Actions; all mutations are API routes).
//
//  2. RC-C/RC-G (CSP) — attach a strict Content-Security-Policy (single source:
//     `lib/security/csp.ts#buildCsp`) to every app/page response so a renderer
//     denylist bypass cannot exfiltrate off-machine (`connect-src 'self'`).
//
// The matcher covers ALL routes except Next internals/static so the CSP protects
// the editor + render pages (the renderer that compiles draw functions), not just
// the API. Static assets are excluded — the CSP lives on the document response and
// governs the whole page regardless.
export const config = {
  // `api/export/render-result` is deliberately EXCLUDED: the Chromium render
  // page posts the whole encoded video file here (real exports can be far
  // beyond the proxy's body-clone cap, and Next buffers the entire clone in
  // memory). The route is token-authenticated per job (random UUID checked in
  // lib/export/render-jobs.ts#getRenderJob), and re-runs this file's origin
  // guard itself before reading the body (spec §4.10), so skipping the proxy
  // restores true streaming without losing either. Every other route (uploads included)
  // stays guarded; their body cap is experimental.proxyClientMaxBodySize in
  // next.config.ts. See __tests__/unit/security/proxy-body-size.test.ts.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/export/render-result).*)"],
};

export function proxy(req: NextRequest) {
  // CSRF/Origin guard: API routes only, preserving the exact Task 1 behavior.
  if (req.nextUrl.pathname.startsWith("/api")) {
    const verdict = evaluateRequestOrigin({
      method: req.method,
      secFetchSite: req.headers.get("sec-fetch-site"),
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      serverHost: req.headers.get("host"),
    });
    if (!verdict.allow) {
      return NextResponse.json(
        { error: "forbidden_cross_origin", reason: verdict.reason },
        { status: 403 },
      );
    }
  }

  const res = NextResponse.next();
  // Emit the CSP on every allowed response (harmless on API JSON). Three
  // policies, picked by path, exactly one per response:
  //   - the routes that serve STORED BYTES (template media, a file's content)
  //     get the media policy: no script, an opaque origin. It has to be set
  //     HERE — this header overwrites the one a route sets. See
  //     lib/security/media-paths.ts. Tested FIRST, so no other policy can
  //     stand in for it on those paths.
  //   - the overlay runtime page gets its own, stricter policy
  //     (`buildOverlayRuntimeCsp`, incl. `sandbox allow-scripts`) — see
  //     lib/security/csp.ts#cspForPath. No media path matches it, so the
  //     media test above can never override it.
  //   - everything else gets the app policy.
  //
  // The origin comes from the HOST HEADER, not `req.nextUrl.origin`: Next
  // normalises `nextUrl` to the dev server's configured origin (always
  // `http://localhost:<port>`), so a page opened at `http://127.0.0.1:<port>`
  // was handed a policy naming localhost — and since this header OVERWRITES
  // the one the route set, the browser would refuse the runtime page's own
  // bundle (`script-src` naming a different origin) and refuse to be framed by
  // the app. Measured live on 3461, not theorised.
  //
  // `parseLoopbackAuthority`, not `isLoopbackHost`: this is the one place a
  // request header reaches into the VALUE of a security header, and a Host may
  // legally carry spaces and semicolons, so only a whole well-formed loopback
  // authority is taken (`127.0.0.1:1; frame-ancestors *` is not one). Anything
  // else falls back to `nextUrl.origin` — the server's own configured origin —
  // so a policy this emits never carries a string the request supplied. The
  // runtime route separately answers such a request 400.
  const pathname = req.nextUrl.pathname;
  if (isMediaServingPath(pathname)) {
    res.headers.set("Content-Security-Policy", MEDIA_RESPONSE_CSP);
    return res;
  }
  const authority = parseLoopbackAuthority(req.headers.get("host"));
  const origin = authority ? `http://${authority}` : req.nextUrl.origin;
  res.headers.set("Content-Security-Policy", cspForPath(pathname, origin));
  return res;
}

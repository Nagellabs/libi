import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { evaluateRequestOrigin } from "@/lib/security/request-guard";
import { buildCsp } from "@/lib/security/csp";

// Next 16 renamed the `middleware` file convention to `proxy` (deprecated `middleware`).
// This runs before matched routes on the Node runtime and is the single chokepoint
// enforcing two security controls:
//
//  1. RC-A (CSRF/Origin) — reject cross-origin browser mutations (CSRF /
//     text-plain form POSTs) and DNS-rebinding hosts, while allowing same-origin
//     browser requests and the internal MCP-child Node client. This applies to
//     `/api/*` ONLY (the app has no Server Actions; all mutations are API routes).
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
  // lib/export/render-jobs.ts#getRenderJob), so a cross-origin POST without
  // the token is a cheap 404 — the CSRF guard adds nothing there, and skipping
  // the proxy restores true streaming. Every other route (uploads included)
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
  // Emit the strict CSP on every allowed response (harmless on API JSON).
  res.headers.set("Content-Security-Policy", buildCsp());
  return res;
}

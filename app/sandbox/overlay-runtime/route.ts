/**
 * The sandboxed overlay runtime page — the SUPERVISOR (spec §4.1 + A1). A
 * hand-written HTML shell like `/render`, NOT a Next page: it loads exactly one
 * script — the content-hashed supervisor bundle with the worker source
 * embedded, named by ABSOLUTE URL because the page runs at an opaque origin
 * (`<iframe sandbox="allow-scripts">`), where `'self'` matches nothing — and
 * nothing else. The response carries the strict CSP from lib/security/csp.ts;
 * proxy.ts emits the same policy for this path, so the header holds whichever
 * layer answers.
 */
import { parseLoopbackAuthority } from "@/lib/security/request-guard";
import { buildOverlayRuntimeCsp, OVERLAY_RUNTIME_BUNDLE_PATH } from "@/lib/security/csp";
import { getOverlayRuntimeBundle } from "@/lib/sandbox/runtime-bundle";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  // The whole authority is validated, not just its hostname: `host` is
  // interpolated into the CSP and into the <script src> attribute below, and a
  // header value may legally carry spaces, quotes and semicolons — so
  // `127.0.0.1:1"><x>` passes a hostname-only check and would be injected here.
  const host = parseLoopbackAuthority(req.headers.get("host"));
  if (!host) {
    return new Response("overlay runtime is loopback-only", { status: 400 });
  }
  const origin = `http://${host}`;
  const bundle = await getOverlayRuntimeBundle();
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>libi overlay runtime</title>
  </head>
  <body>
    <script src="${origin}${OVERLAY_RUNTIME_BUNDLE_PATH}?v=${bundle.hash}"></script>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": buildOverlayRuntimeCsp(origin),
    },
  });
}

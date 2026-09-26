import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { buildCsp, buildOverlayRuntimeCsp, OVERLAY_RUNTIME_BUNDLE_PATH, OVERLAY_RUNTIME_PATH } from "@/lib/security/csp";

/**
 * Final review I1(c): Next copies the proxy's headers onto the response before
 * the route runs and keeps them over the route's own, so the SVG sandbox CSP the
 * template media route set never reached the browser — the page CSP (with
 * `script-src 'unsafe-inline'`) did. The media-serving paths now get their
 * strict policy from the proxy itself. `e2e/media-headers.spec.ts` asserts the
 * FINAL headers through a real server; this pins the proxy's decision.
 */
function cspFor(pathname: string): string | null {
  const res = proxy(new NextRequest(`http://127.0.0.1:3461${pathname}`, { headers: { host: "127.0.0.1:3461" } }));
  return res.headers.get("Content-Security-Policy");
}

describe("proxy: media-serving paths get the media CSP", () => {
  it("template media and stored file content", () => {
    expect(cspFor("/api/templates/0b1c/media/logo.svg")).toBe("default-src 'none'; sandbox");
    expect(cspFor("/api/templates/0b1c/media/poster.jpg")).toBe("default-src 'none'; sandbox");
    // A stranger's audio/video, streamed from their host (D5–D6): the media policy too.
    expect(cspFor("/api/templates/cloud/asset-stream")).toBe("default-src 'none'; sandbox");
    expect(cspFor("/api/files/by-id/f-1/content")).toBe("default-src 'none'; sandbox");
  });
  // Final re-review 1, I1: the by-FILENAME route serves the same stored bytes.
  it("a piece file served by its filename", () => {
    expect(cspFor("/api/files/piece-1/logo.svg")).toBe("default-src 'none'; sandbox");
    expect(cspFor("/api/files/piece-1/x.svg")).toBe("default-src 'none'; sandbox");
  });
  it("every other path keeps the page CSP", () => {
    for (const p of ["/editor", "/api/templates", "/api/templates/0b1c", "/api/files/by-id/f-1/proxy", "/api/files/by-id/f-1/content/x", "/templates"]) {
      expect(cspFor(p), p).toBe(buildCsp());
    }
  });
});

/**
 * feat/templates-sandbox merged into feat/templates: the proxy now picks one of
 * THREE policies. The media policy is tested first, but it must never stand in
 * for the overlay runtime page's own (`sandbox allow-scripts`, `connect-src
 * 'none'`, `frame-ancestors <studio>`), and neither may leak onto the other.
 */
describe("proxy: the overlay runtime keeps its own policy beside the media policy", () => {
  it("the runtime page gets buildOverlayRuntimeCsp for the Host's origin, not the media or app CSP", () => {
    const csp = cspFor(OVERLAY_RUNTIME_PATH);
    expect(csp).toBe(buildOverlayRuntimeCsp("http://127.0.0.1:3461"));
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toBe("default-src 'none'; sandbox");
    expect(csp).not.toBe(buildCsp());
  });
  it("the runtime bundle route is not a media path: it keeps the app CSP", () => {
    expect(cspFor(OVERLAY_RUNTIME_BUNDLE_PATH)).toBe(buildCsp());
  });
  it("a media path gets the media CSP whatever the Host says, and never the runtime policy", () => {
    const res = proxy(
      new NextRequest("http://127.0.0.1:3461/api/files/by-id/f-1/content", { headers: { host: "127.0.0.1:1; frame-ancestors *" } }),
    );
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  });
  it("the app CSP still lets a same-origin <embed> of a stored PDF load (object-src and frame-ancestors 'self')", () => {
    expect(buildCsp()).toContain("object-src 'self'");
    expect(buildCsp()).toContain("frame-ancestors 'self'");
    // The PDF itself is served with the media CSP, which carries no frame-ancestors.
    expect(cspFor("/api/files/by-id/f-1/content")).not.toContain("frame-ancestors");
  });
});

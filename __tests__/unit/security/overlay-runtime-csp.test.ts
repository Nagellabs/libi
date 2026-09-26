import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import {
  buildCsp,
  buildOverlayRuntimeCsp,
  cspForPath,
  OVERLAY_RUNTIME_PATH,
  OVERLAY_RUNTIME_BUNDLE_PATH,
} from "@/lib/security/csp";

const ORIGIN = "http://127.0.0.1:3456";

describe("buildOverlayRuntimeCsp (spec §4.1 + A1)", () => {
  it("is the strict policy, verbatim, with the worker allowances A1 measured", () => {
    expect(buildOverlayRuntimeCsp(ORIGIN)).toBe(
      "default-src 'none'; " +
        `script-src ${ORIGIN}${OVERLAY_RUNTIME_BUNDLE_PATH} 'unsafe-eval' blob:; ` +
        "img-src blob: data:; font-src data:; connect-src 'none'; worker-src blob:; " +
        `frame-ancestors ${ORIGIN}; base-uri 'none'; form-action 'none'; sandbox allow-scripts`,
    );
  });
  it("names the bundle by absolute URL and never uses 'self' (the runtime origin is opaque)", () => {
    const csp = buildOverlayRuntimeCsp("http://localhost:3461");
    expect(csp).toContain("script-src http://localhost:3461/api/sandbox/runtime-bundle 'unsafe-eval' blob:");
    expect(csp).not.toContain("'self'");
  });
});

describe("cspForPath", () => {
  it("emits the strict policy for the runtime page only", () => {
    expect(cspForPath(OVERLAY_RUNTIME_PATH, ORIGIN)).toBe(buildOverlayRuntimeCsp(ORIGIN));
    expect(cspForPath("/editor", ORIGIN)).toBe(buildCsp());
    expect(cspForPath("/render", ORIGIN)).toBe(buildCsp());
    expect(cspForPath(OVERLAY_RUNTIME_BUNDLE_PATH, ORIGIN)).toBe(buildCsp());
  });
});

describe("proxy emits the runtime policy for the host the browser actually used", () => {
  it("takes the origin from the Host header, not nextUrl (which Next pins to localhost in dev)", () => {
    // Live on port 3461: a GET to http://127.0.0.1:3461/sandbox/overlay-runtime
    // came back with `script-src http://localhost:3461/...`, because
    // `req.nextUrl.origin` is the dev server's configured origin. The proxy's
    // header overwrites the route's, so the page would have been refused its
    // own bundle. This pins the Host header as the source.
    const req = new NextRequest("http://localhost:3461/sandbox/overlay-runtime", {
      headers: { host: "127.0.0.1:3461" },
    });
    expect(proxy(req).headers.get("content-security-policy")).toBe(
      buildOverlayRuntimeCsp("http://127.0.0.1:3461"),
    );
  });
  it.each([
    ["a rebound host", "evil.example"],
    ["a second source smuggled after the port", "127.0.0.1:3456 evil.example"],
    ["a directive smuggled after the port", "127.0.0.1:1; frame-ancestors *"],
    ["markup smuggled after the port", '127.0.0.1:1"><x>'],
  ])("never lets %s shape the policy; it falls back to the server's own origin", (_label, host) => {
    const req = new NextRequest("http://127.0.0.1:3461/sandbox/overlay-runtime", { headers: { host } });
    const csp = proxy(req).headers.get("content-security-policy");
    expect(csp).not.toContain(host);
    expect(csp).toContain("frame-ancestors http://localhost:3461;");
    // `nextUrl.origin` is the fallback — and note it normalises 127.0.0.1 to
    // localhost, which is the very reason the Host header is preferred above.
    expect(csp).toBe(buildOverlayRuntimeCsp(req.nextUrl.origin));
  });
  it("leaves every other path on the app policy", () => {
    const req = new NextRequest("http://127.0.0.1:3461/editor", { headers: { host: "127.0.0.1:3461" } });
    expect(proxy(req).headers.get("content-security-policy")).toBe(buildCsp());
  });
});

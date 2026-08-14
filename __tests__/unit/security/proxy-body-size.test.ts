import { describe, it, expect } from "vitest";
import { config as proxyConfig } from "@/proxy";
import nextConfig from "../../../next.config";

/**
 * Regression pin for the Next 16 proxy body-clone limit (the
 * "Request body exceeded 10MB for /api/export/render-result" 400).
 *
 * Two halves:
 *  1. `api/export/render-result` is EXCLUDED from the proxy matcher — the
 *     render page posts whole video files (exports can be multi-GB); the route
 *     is token-authenticated (per-job random UUID), so skipping the CSRF/CSP
 *     proxy is safe and restores true streaming (no in-memory clone at all).
 *  2. Everything else (uploads!) keeps the proxy but with the clone cap raised
 *     to 2GB via `experimental.proxyClientMaxBodySize` (the CURRENT config
 *     name in this Next build; `middlewareClientMaxBodySize` is the deprecated
 *     alias named by the runtime warning).
 */
describe("proxy body-size regression pins", () => {
  // Reconstruct the compiled matcher semantics: Next compiles
  // "/((?!a|b).*)" to ^\/((?!a|b).*)$ — good enough to assert route coverage.
  const matcher = (proxyConfig.matcher as string[])[0];
  const re = new RegExp("^" + matcher.replace(/\//g, "\\/") + "$");

  it("excludes the render postback route from the proxy matcher", () => {
    expect(re.test("/api/export/render-result")).toBe(false);
  });

  it("still guards every other API route (CSRF/Origin + CSP intact)", () => {
    expect(re.test("/api/agent/send")).toBe(true);
    expect(re.test("/api/upload")).toBe(true);
    expect(re.test("/api/pieces/p1/upload")).toBe(true);
    expect(re.test("/api/export/render-progress")).toBe(true);
    expect(re.test("/api/export/render-error")).toBe(true);
  });

  it("raises the proxy body-clone cap to 2gb for the guarded routes", () => {
    expect(
      (nextConfig as { experimental?: { proxyClientMaxBodySize?: string | number } })
        .experimental?.proxyClientMaxBodySize,
    ).toBe("2gb");
  });
});

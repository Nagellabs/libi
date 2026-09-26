import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

/**
 * The DNS-rebinding gate covers reads, not only mutations: a page that rebinds
 * its hostname to 127.0.0.1 is same-origin to the browser and could read any
 * GET (the legacy provider key notice, pieces, a template's index.md). Its Host
 * is still its own name, which is what these pin. Cross-site reads from a
 * loopback Host stay allowed on purpose — see crossSiteSubresourceRefusal.
 */
function call(method: string, pathname: string, headers: Record<string, string>) {
  return proxy(new NextRequest(`http://${headers.host}${pathname}`, { method, headers }));
}

describe("proxy: reads carry a loopback Host too", () => {
  it("refuses a rebound Host on GET /api/providers/legacy and /api/pieces", async () => {
    for (const p of ["/api/providers/legacy", "/api/pieces"]) {
      const res = call("GET", p, { host: "evil.example:3461", "sec-fetch-site": "same-origin" });
      expect(res.status, p).toBe(403);
      expect((await res.json()).reason).toBe("non_loopback_host");
    }
  });
  it("passes loopback reads, including the sandbox's cross-site bundle load and a cross-site media load", () => {
    const pass = (p: string, h: Record<string, string>) => expect(call("GET", p, h).headers.get("x-middleware-next"), p).toBe("1");
    pass("/api/pieces", { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" });
    pass("/api/sandbox/runtime-bundle", { host: "127.0.0.1:3461", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" });
    pass("/api/test-mode/templates-catalog/bucket/templates/x/v1/poster.jpg", { host: "127.0.0.1:3461", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" });
    pass("/api/pieces", { host: "localhost:3461" });
  });
  it("leaves non-API pages to their own routes", () => {
    expect(call("GET", "/editor", { host: "127.0.0.1:3461", "sec-fetch-site": "none", "sec-fetch-mode": "navigate" }).status).toBe(200);
  });
});

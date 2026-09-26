import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

/**
 * Task A10 review I-1: the creator key is a bearer secret, so the one route
 * that returns it is a POST — the proxy's origin gate covers every unsafe
 * method, while a loopback GET passes whatever its origin
 * (lib/security/request-guard.ts; the DNS-rebinding Host check covers both).
 * A page rebound to 127.0.0.1 is same-origin to the browser, but its Host is
 * its own name; that is what these pin.
 */
function call(method: string, pathname: string, headers: Record<string, string>) {
  return proxy(new NextRequest(`http://${headers.host}${pathname}`, { method, headers }));
}
const REVEAL = "/api/templates/cloud/key/reveal";

describe("proxy: the creator key reveal is origin-guarded", () => {
  it("refuses a DNS-rebound Host even when the browser says same-origin", async () => {
    const res = call("POST", REVEAL, { host: "attacker.example:3461", origin: "http://attacker.example:3461", "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("non_loopback_host");
  });

  it("refuses another loopback origin (a page on another port) and a cross-site fetch", () => {
    expect(call("POST", REVEAL, { host: "127.0.0.1:3461", origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" }).status).toBe(403);
    expect(call("POST", REVEAL, { host: "127.0.0.1:3461", "sec-fetch-site": "cross-site" }).status).toBe(403);
  });

  it("lets the studio's own page through", () => {
    const res = call("POST", REVEAL, { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

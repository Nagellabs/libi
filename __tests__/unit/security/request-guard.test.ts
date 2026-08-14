import { describe, it, expect } from "vitest";
import { evaluateRequestOrigin, isLoopbackHost, isSafeMethod } from "@/lib/security/request-guard";

const base = { host: "127.0.0.1:3000", origin: null, serverHost: "127.0.0.1:3000" };

describe("isLoopbackHost", () => {
  it("accepts loopback hosts on any port", () => {
    expect(isLoopbackHost("127.0.0.1:3000")).toBe(true);
    expect(isLoopbackHost("localhost:9999")).toBe(true);
    expect(isLoopbackHost("[::1]:3000")).toBe(true);
  });
  it("rejects foreign / rebinding hosts", () => {
    expect(isLoopbackHost("rebind.attacker.example")).toBe(false);
    expect(isLoopbackHost("192.168.1.5:3000")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });
});

describe("evaluateRequestOrigin", () => {
  it("allows all safe methods regardless of origin", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"])
      expect(evaluateRequestOrigin({ ...base, method: m, secFetchSite: "cross-site" }).allow).toBe(true);
  });
  it("allows same-origin browser mutations", () => {
    expect(evaluateRequestOrigin({ ...base, method: "POST", secFetchSite: "same-origin" }).allow).toBe(true);
    expect(evaluateRequestOrigin({ ...base, method: "POST", secFetchSite: "none" }).allow).toBe(true);
  });
  it("blocks cross-site browser mutations (CSRF)", () => {
    const r = evaluateRequestOrigin({ ...base, method: "POST", secFetchSite: "cross-site" });
    expect(r.allow).toBe(false); expect(r.reason).toBe("cross_site_fetch");
  });
  it("allows the internal Node client (no Sec-Fetch-Site, loopback host)", () => {
    expect(evaluateRequestOrigin({ ...base, method: "POST", secFetchSite: null }).allow).toBe(true);
  });
  it("blocks a rebound host even with no Sec-Fetch-Site", () => {
    const r = evaluateRequestOrigin({ method: "POST", secFetchSite: null, host: "rebind.attacker.example", origin: null, serverHost: null });
    expect(r.allow).toBe(false); expect(r.reason).toBe("non_loopback_host");
  });
  it("rejects a DNS-rebinding mutation (forged same-origin, non-loopback Host/Origin/serverHost)", () => {
    const r = evaluateRequestOrigin({
      method: "POST",
      secFetchSite: "same-origin",
      host: "attacker.com:3000",
      origin: "http://attacker.com:3000",
      serverHost: "attacker.com:3000",
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("non_loopback_host");
  });
  it("blocks a foreign Origin header", () => {
    const r = evaluateRequestOrigin({ ...base, method: "POST", secFetchSite: null, origin: "https://evil.example" });
    expect(r.allow).toBe(false); expect(r.reason).toBe("foreign_origin");
  });
  it("blocks same-site browser mutations (still cross-origin for CSRF)", () => {
    const r = evaluateRequestOrigin({ ...base, method: "POST", secFetchSite: "same-site" });
    expect(r.allow).toBe(false); expect(r.reason).toBe("cross_site_fetch");
  });
  it("is case-insensitive about the method (lowercase post, cross-site)", () => {
    const r = evaluateRequestOrigin({ ...base, method: "post", secFetchSite: "cross-site" });
    expect(r.allow).toBe(false); expect(r.reason).toBe("cross_site_fetch");
  });
  it("blocks a malformed Origin header", () => {
    const r = evaluateRequestOrigin({ ...base, method: "POST", secFetchSite: null, origin: "http://[" });
    expect(r.allow).toBe(false); expect(r.reason).toBe("bad_origin");
  });
  it("blocks a cross-port loopback Origin (localhost:OTHER != server host:port)", () => {
    const r = evaluateRequestOrigin({ method: "POST", secFetchSite: null, host: "127.0.0.1:3000", origin: "http://localhost:9999", serverHost: "127.0.0.1:3000" });
    expect(r.allow).toBe(false); expect(r.reason).toBe("foreign_origin");
  });
  it("allows a matching Origin (host==serverHost, no Sec-Fetch-Site)", () => {
    const r = evaluateRequestOrigin({ method: "POST", secFetchSite: null, host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", serverHost: "127.0.0.1:3000" });
    expect(r.allow).toBe(true);
  });
});

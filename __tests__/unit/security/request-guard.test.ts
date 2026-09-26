import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { crossSiteSubresourceRefusal, evaluateRequestOrigin, isLoopbackHost, parseLoopbackAuthority } from "@/lib/security/request-guard";

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

describe("evaluateRequestOrigin — reads", () => {
  it("refuses a GET/HEAD/OPTIONS whose Host is not loopback (DNS rebinding)", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      const r = evaluateRequestOrigin({ method: m, secFetchSite: "same-origin", host: "evil.example:3456", origin: null, serverHost: "evil.example:3456" });
      expect(r).toEqual({ allow: false, reason: "non_loopback_host" });
    }
  });
  it("allows loopback reads whatever Sec-Fetch-Site says (the sandbox, localhost↔127.0.0.1 media, header-less clients)", () => {
    for (const site of ["same-origin", "none", "cross-site", "same-site", null]) {
      for (const host of ["127.0.0.1:3461", "localhost:3461", "[::1]:3461"]) {
        expect(evaluateRequestOrigin({ method: "GET", secFetchSite: site, host, origin: null, serverHost: host }), `${site} ${host}`).toEqual({ allow: true, reason: "safe_method" });
      }
    }
  });
  it("a missing Host is refused on reads too", () => {
    expect(evaluateRequestOrigin({ method: "GET", secFetchSite: null, host: null, origin: null, serverHost: null }).allow).toBe(false);
  });
});

describe("crossSiteSubresourceRefusal", () => {
  const req = (h: Record<string, string>) => new Request("http://127.0.0.1:3461/api/templates/cloud/mine", { headers: { host: "127.0.0.1:3461", ...h } });
  it("refuses a cross-site or same-site request, navigations included (a hidden iframe or GET form runs the handler)", () => {
    for (const site of ["cross-site", "same-site"]) for (const mode of ["no-cors", "cors", "navigate"]) expect(crossSiteSubresourceRefusal(req({ "sec-fetch-site": site, "sec-fetch-mode": mode }))).toBe("cross_site_read");
  });
  it("passes the studio's own fetch, a typed URL or bookmark, and a header-less internal client", () => {
    expect(crossSiteSubresourceRefusal(req({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }))).toBeNull();
    expect(crossSiteSubresourceRefusal(req({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate" }))).toBeNull();
    expect(crossSiteSubresourceRefusal(req({}))).toBeNull();
  });
});

describe("evaluateRequestOrigin", () => {
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

describe("parseLoopbackAuthority (the CSP/script-src source)", () => {
  it("accepts a loopback authority, with or without a port, and returns it verbatim", () => {
    expect(parseLoopbackAuthority("127.0.0.1:3456")).toBe("127.0.0.1:3456");
    expect(parseLoopbackAuthority("localhost:3461")).toBe("localhost:3461");
    expect(parseLoopbackAuthority("[::1]:3456")).toBe("[::1]:3456");
    expect(parseLoopbackAuthority("127.0.0.1")).toBe("127.0.0.1");
    expect(parseLoopbackAuthority("localhost")).toBe("localhost");
  });
  it("rejects anything trailing the port — isLoopbackHost only ever checked the hostname", () => {
    // Each of these passes `isLoopbackHost` (it splits on ":" and checks [0]),
    // and each would otherwise land verbatim inside the runtime page's CSP and
    // its <script src> attribute.
    for (const host of [
      "127.0.0.1:3456 evil.example",
      '127.0.0.1:1"><x>',
      "127.0.0.1:1; frame-ancestors *",
      "localhost:3461/../..",
      "127.0.0.1:",
      "127.0.0.1:abc",
    ]) {
      expect(isLoopbackHost(host)).toBe(true); // the old check is happy
      expect(parseLoopbackAuthority(host)).toBeNull(); // this one is not
    }
  });
  it("rejects non-loopback hosts and nothing at all", () => {
    expect(parseLoopbackAuthority("evil.example")).toBeNull();
    expect(parseLoopbackAuthority("127.0.0.1.evil.example")).toBeNull();
    expect(parseLoopbackAuthority(null)).toBeNull();
    expect(parseLoopbackAuthority("")).toBeNull();
  });
});

// Review M6 (2026-09-25): the doc is where an audit looks for "GETs that spend the creator key or call the site".
describe("crossSiteSubresourceRefusal's list of guarded GETs", () => {
  function routesUsingIt(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return routesUsingIt(p);
      return e.name === "route.ts" && readFileSync(p, "utf8").includes("crossSiteSubresourceRefusal(") ? [p] : [];
    });
  }
  /**
   * The other direction (final review F6): a GET whose handler reaches the
   * catalog, the creator key or a third-party host must call the guard. The
   * handler's own text is scanned for the calls that do — every exported
   * async function of the catalog client (read from the file, so a new one
   * is covered), and the wrappers the routes use — so a new such GET that
   * forgets the guard fails here.
   */
  it("every GET whose handler calls the site, spends the creator key or fetches a third party calls it", () => {
    const client = readFileSync(path.resolve("lib/templates/cloud/client.ts"), "utf8");
    const siteCalls = new Set([...client.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]));
    for (const wrapper of [
      "refreshCatalogIfStale",
      "ensureCatalogForRead",
      "catalogScaffold",
      "confirmStreamableAsset",
      "openAssetStream",
      "getOrCreateTemplatesAuthor",
      "checkCreatorApproved",
      "readCreatorStatus",
    ])
      siteCalls.add(wrapper);
    const offenders: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return e.name === "route.ts" ? [p] : [];
      });
    /** The body of `function <name>(…) … { … }` in `src` (balanced parens, then braces), or null. */
    const bodyOf = (src: string, name: string): string | null => {
      const m = new RegExp(`function ${name}\\s*\\(`).exec(src);
      if (!m) return null;
      let i = m.index + m[0].length;
      for (let depth = 1; depth > 0 && i < src.length; i++) depth += src[i] === "(" ? 1 : src[i] === ")" ? -1 : 0;
      const open = src.indexOf("{", i);
      if (open < 0) return null;
      let j = open + 1;
      for (let depth = 1; depth > 0 && j < src.length; j++) depth += src[j] === "{" ? 1 : src[j] === "}" ? -1 : 0;
      return src.slice(m.index, j);
    };
    let checked = 0;
    for (const file of walk(path.resolve("app/api"))) {
      const src = readFileSync(file, "utf8");
      const handler = bodyOf(src, "GET");
      if (!handler) continue;
      // The handler, plus every same-file function it reaches (its helpers can call the site too).
      const local = [...src.matchAll(/function (\w+)\s*\(/g)].map((m) => m[1]).filter((n) => n !== "GET");
      const seen = new Set<string>();
      let body = handler;
      for (let grew = true; grew; ) {
        grew = false;
        for (const fn of local) {
          if (seen.has(fn) || !new RegExp(`\\b${fn}\\(`).test(body)) continue;
          seen.add(fn);
          body += `\n${bodyOf(src, fn) ?? ""}`;
          grew = true;
        }
      }
      const calls = [...siteCalls].filter((fn) => new RegExp(`\\b${fn}\\(`).test(body));
      if (calls.length === 0) continue;
      checked++;
      if (!handler.includes("crossSiteSubresourceRefusal(")) offenders.push(`${path.relative(process.cwd(), file)} (${calls.join(", ")})`);
    }
    expect(checked).toBeGreaterThanOrEqual(6); // the scan does find the known ones
    expect(offenders).toEqual([]);
  });

  it("names every route that calls it, in request-guard.ts and in AGENTS.md", () => {
    const routes = routesUsingIt(path.resolve("app/api")).map((p) => `/${path.relative(path.resolve("app"), path.dirname(p)).split(path.sep).join("/")}`);
    expect(routes).toContain("/api/templates/cloud/creator");
    const guardDoc = readFileSync(path.resolve("lib/security/request-guard.ts"), "utf8").replace(/\n \* /g, " ");
    const agents = readFileSync(path.resolve("AGENTS.md"), "utf8");
    for (const r of routes) {
      expect(guardDoc, r).toContain(`\`${r}\``);
      expect(agents, r).toContain(`\`${r}\``);
    }
  });
});

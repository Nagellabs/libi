import { afterEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/sandbox/runtime-bundle", () => ({
  getOverlayRuntimeBundle: async () => ({ code: "// supervisor+worker", hash: "deadbeefdeadbeef", bytes: 21, durationMs: 1 }),
  getOverlayWorkerBundle: async () => ({ code: "// worker", hash: "cafebabecafebabe", bytes: 9, durationMs: 1 }),
}));

import { GET as pageGet } from "@/app/sandbox/overlay-runtime/route";
import { GET as bundleGet } from "@/app/api/sandbox/runtime-bundle/route";
import { buildOverlayRuntimeCsp } from "@/lib/security/csp";

describe("GET /sandbox/overlay-runtime (the supervisor page)", () => {
  it("serves a shell whose only script is the content-hashed bundle by absolute URL, under the strict CSP, no-store", async () => {
    const res = await pageGet(new Request("http://127.0.0.1:3456/sandbox/overlay-runtime", { headers: { host: "127.0.0.1:3456" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe(buildOverlayRuntimeCsp("http://127.0.0.1:3456"));
    const html = await res.text();
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('src="http://127.0.0.1:3456/api/sandbox/runtime-bundle?v=deadbeefdeadbeef"');
    expect(html).not.toMatch(/<script>[^<]/); // no inline script at all
  });
  it("uses the request's own host for the origin (localhost stays localhost)", async () => {
    const res = await pageGet(new Request("http://localhost:3461/sandbox/overlay-runtime", { headers: { host: "localhost:3461" } }));
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors http://localhost:3461");
  });
  it.each([
    "evil.example",
    "127.0.0.1:3456 evil.example",
    '127.0.0.1:1"><x>',
    "127.0.0.1:1; frame-ancestors *",
  ])("refuses a host that is not a whole loopback authority: %s", async (host) => {
    // A hostname-only check (isLoopbackHost) accepts the last three, and the
    // value is interpolated into the CSP and the <script src> attribute.
    const res = await pageGet(new Request("http://127.0.0.1:3456/sandbox/overlay-runtime", { headers: { host } }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sandbox/runtime-bundle", () => {
  it("serves the combined script as JavaScript with an ETag equal to the hash", async () => {
    const res = await bundleGet(new Request("http://127.0.0.1:3456/api/sandbox/runtime-bundle?v=deadbeefdeadbeef"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(res.headers.get("etag")).toBe('"deadbeefdeadbeef"');
    expect(await res.text()).toBe("// supervisor+worker");
  });
  it("serves the worker alone for ?part=worker (the in-origin dev mode)", async () => {
    const res = await bundleGet(new Request("http://127.0.0.1:3456/api/sandbox/runtime-bundle?part=worker"));
    expect(res.headers.get("etag")).toBe('"cafebabecafebabe"');
    expect(await res.text()).toBe("// worker");
  });
  it("answers 304 to a matching If-None-Match", async () => {
    const res = await bundleGet(new Request("http://127.0.0.1:3456/api/sandbox/runtime-bundle", { headers: { "if-none-match": '"deadbeefdeadbeef"' } }));
    expect(res.status).toBe(304);
  });
});

describe("GET /api/sandbox/runtime-bundle — immutable only for a URL that names the hash", () => {
  afterEach(() => vi.unstubAllEnvs());

  const cc = async (url: string) =>
    (await bundleGet(new Request(url))).headers.get("cache-control");

  it("a year-long immutable entry needs ?v= to MATCH the hash of the part served", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Without it, an upgrade could never dislodge the cached copy: the URL is
    // the same and the browser would not revalidate for a year.
    expect(await cc("http://127.0.0.1:3456/api/sandbox/runtime-bundle?v=deadbeefdeadbeef")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await cc("http://127.0.0.1:3456/api/sandbox/runtime-bundle?part=worker&v=cafebabecafebabe")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("every un-hashed or stale-hashed URL revalidates instead (ETag)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await cc("http://127.0.0.1:3456/api/sandbox/runtime-bundle")).toBe("no-cache");
    expect(await cc("http://127.0.0.1:3456/api/sandbox/runtime-bundle?part=worker")).toBe("no-cache");
    // the runtime hash on the worker part, and an old hash: neither is immutable
    expect(await cc("http://127.0.0.1:3456/api/sandbox/runtime-bundle?part=worker&v=deadbeefdeadbeef")).toBe("no-cache");
    expect(await cc("http://127.0.0.1:3456/api/sandbox/runtime-bundle?v=0000000000000000")).toBe("no-cache");
  });

  it("never immutable outside production, however the URL is spelled", async () => {
    expect(await cc("http://127.0.0.1:3456/api/sandbox/runtime-bundle?v=deadbeefdeadbeef")).toBe("no-cache");
  });
});

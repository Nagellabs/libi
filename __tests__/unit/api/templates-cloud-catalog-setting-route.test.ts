// GET/PUT /api/templates/cloud/catalog-setting: a dev build's Catalog setting
// (Settings → Templates). The switch is the user's own action, the bypass
// token is never answered or logged, a new address never inherits a token,
// and a packaged build has no such setting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema/sqlite";
import { serverLogger } from "@/lib/logger";
import { navigationEmitter } from "@/lib/navigation-events";
import { GET, PUT } from "@/app/api/templates/cloud/catalog-setting/route";
import { __resetDevBuildForTests } from "@/lib/templates/cloud/catalog-setting";
import { catalogSource } from "@/lib/templates/cloud/catalog-source";

const PROD = "https://libi.nagellabs.com";
const PREVIEW = "https://libi-site-git-templates-nagellabs.vercel.app";
const OTHER_PREVIEW = "https://someone-else.vercel.app";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const BROWSER = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin", "content-type": "application/json" };

const put = (body: unknown, headers: Record<string, string> = BROWSER) =>
  PUT(new Request("http://127.0.0.1:3461/api/templates/cloud/catalog-setting", { method: "PUT", headers, body: JSON.stringify(body) }));
const get = async () => (await GET()).json();
const storedRaw = () => getDb().select({ v: settings.templatesCatalog }).from(settings).get()?.v ?? null;

beforeEach(() => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("LIBI_RUNTIME_SOURCE", undefined);
  createTestDb();
  __resetDevBuildForTests();
});
afterEach(() => {
  resetTestDb();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetDevBuildForTests();
});

describe("GET", () => {
  it("a fresh dev build: Production, the setting on offer, no token", async () => {
    expect(await get()).toEqual({
      devBuild: true,
      testMode: false,
      active: { kind: "production", origin: PROD, host: "libi.nagellabs.com" },
      legalOrigin: PROD,
      choice: "production",
      production: { origin: PROD, host: "libi.nagellabs.com" },
      development: { origin: null, isDefault: false, defaultOrigin: null },
      bypassToken: { set: false, applies: false },
    });
  });
  it("a packaged build answers only which catalog it reads — whatever a copied database holds", async () => {
    await put({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    vi.stubEnv("LIBI_RUNTIME_SOURCE", "bundled");
    __resetDevBuildForTests();
    const body = await get();
    expect(body).toEqual({ devBuild: false, testMode: false, active: { kind: "production", origin: PROD, host: "libi.nagellabs.com" }, legalOrigin: PROD });
    expect(JSON.stringify(body)).not.toContain("vercel");
  });
});

describe("PUT", () => {
  it("is the user's own action: an agent's tool call or shell (no browser headers) is refused, nothing written", async () => {
    for (const headers of [{ host: "127.0.0.1:3461", "content-type": "application/json" }, { ...BROWSER, origin: "http://evil.example" }, { ...BROWSER, "sec-fetch-site": "cross-site" }]) {
      const res = await put({ choice: "development", devOrigin: PREVIEW }, headers);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("browser_only");
    }
    expect(storedRaw()).toBeNull();
    expect(catalogSource()).toBe(PROD);
  });

  it("a packaged build has no such setting: 404, nothing written", async () => {
    vi.stubEnv("LIBI_RUNTIME_SOURCE", "bundled");
    __resetDevBuildForTests();
    const res = await put({ choice: "development", devOrigin: PREVIEW });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_dev_build");
    expect(storedRaw()).toBeNull();
  });

  it("switches both ways without a restart, and every window's templates views refresh", async () => {
    const emit = vi.spyOn(navigationEmitter, "emit");
    const res = await put({ choice: "development", devOrigin: `${PREVIEW}/some/path` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ choice: "development", active: { kind: "development", origin: PREVIEW, host: new URL(PREVIEW).host }, legalOrigin: PREVIEW });
    expect(catalogSource()).toBe(PREVIEW);
    expect(emit.mock.calls.map((c) => c[1])).toEqual([{ queryKey: "templates" }, { queryKey: "templates-creator" }, { queryKey: "templates-catalog" }]);
    expect(await (await put({ choice: "production" })).json()).toMatchObject({ choice: "production", active: { kind: "production" }, legalOrigin: PROD, development: { origin: PREVIEW } });
    expect(catalogSource()).toBe(PROD);
  });

  it("works with just a URL — the token is optional, and none is sent without one", async () => {
    const body = await (await put({ choice: "development", devOrigin: PREVIEW })).json();
    expect(body.bypassToken).toEqual({ set: false, applies: false });
  });

  it("validates the address and the token", async () => {
    for (const [b, code] of [
      [{ devOrigin: "http://example.com" }, "invalid_origin"],
      [{ devOrigin: PROD }, "invalid_origin"],
      [{ devOrigin: "https://libi.nagellabs.com." }, "invalid_origin"],
      [{ devOrigin: "https://LIBI.nagellabs.com:443" }, "invalid_origin"],
      [{ choice: "development" }, "no_origin"],
      [{ devOrigin: "http://localhost:3300", bypassToken: TOKEN }, "token_needs_vercel"],
      [{ devOrigin: PREVIEW, bypassToken: "short" }, "invalid_token"],
      [{ choice: "staging" }, "invalid"],
      [{ extra: 1 }, "invalid"],
    ] as const) {
      const res = await put(b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect((await res.json()).code).toBe(code);
    }
    expect(storedRaw()).toBeNull();
  });

  it("never answers or logs the token: masked as set / not set only", async () => {
    const info = vi.spyOn(serverLogger, "info");
    const res = await put({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).bypassToken).toEqual({ set: true, applies: true });
    expect(JSON.stringify(await get())).not.toContain(TOKEN);
    expect(JSON.stringify(info.mock.calls)).not.toContain(TOKEN);
    expect(info.mock.calls.find((c) => (c[0] as { op?: string }).op === "catalog_setting_changed")?.[0]).toMatchObject({ tag: "templates-cloud", tokenSet: true, devHost: new URL(PREVIEW).host });
    // And GET /api/settings never carried it.
    const { GET: SETTINGS } = await import("@/app/api/settings/route");
    expect(await (await SETTINGS()).text()).not.toContain(TOKEN);
  });

  it("a new address never inherits the token — one Vercel project's secret must not reach another's", async () => {
    await put({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    expect((await get()).bypassToken.set).toBe(true);
    expect((await (await put({ devOrigin: OTHER_PREVIEW })).json()).bypassToken).toEqual({ set: false, applies: false });
    expect(storedRaw()).not.toContain(TOKEN);
    // The same address again keeps it; clearing it clears it.
    await put({ devOrigin: OTHER_PREVIEW, bypassToken: TOKEN });
    expect((await (await put({ devOrigin: `${OTHER_PREVIEW}/` })).json()).bypassToken.set).toBe(true);
    expect((await (await put({ bypassToken: null })).json()).bypassToken.set).toBe(false);
    expect(storedRaw()).not.toContain(TOKEN);
  });

  it("the NEXT_PUBLIC_LIBI_SITE_URL default is stored once Development is chosen", async () => {
    vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", "http://localhost:3300");
    vi.resetModules();
    const route = await import("@/app/api/templates/cloud/catalog-setting/route");
    (await import("@/lib/templates/cloud/catalog-setting")).__resetDevBuildForTests();
    const first = await (await route.GET()).json();
    expect(first).toMatchObject({ choice: "development", development: { origin: "http://localhost:3300", isDefault: true, defaultOrigin: "http://localhost:3300" } });
    const req = (body: unknown) => new Request("http://127.0.0.1:3461/api/templates/cloud/catalog-setting", { method: "PUT", headers: BROWSER, body: JSON.stringify(body) });
    await route.PUT(req({ choice: "production" }));
    expect(await (await route.PUT(req({ choice: "development" }))).json()).toMatchObject({ active: { origin: "http://localhost:3300" }, development: { isDefault: false } });
  });

  it("a stored setting that can't be read is answered 500 read_failed, logged by name — and nothing is written over it (review M8)", async () => {
    await put({ choice: "development", devOrigin: PREVIEW, bypassToken: TOKEN });
    const before = storedRaw();
    // A database that can't be read (busy, damaged): the table is out of reach for this request.
    getDb().run("ALTER TABLE settings RENAME TO settings_away" as never);
    const errorLog = vi.spyOn(serverLogger, "error");
    let res: Response;
    try {
      res = await put({ choice: "production" });
    } finally {
      getDb().run("ALTER TABLE settings_away RENAME TO settings" as never);
    }
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe("read_failed");
    expect(text).not.toContain(TOKEN);
    expect(errorLog.mock.calls.find((c) => (c[0] as { op?: string }).op === "catalog_setting_read_failed")?.[0]).toEqual({ tag: "templates-cloud", op: "catalog_setting_read_failed", err: "SqliteError" });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(TOKEN);
    // Nothing was written over it: the stored address and token are as they were.
    expect(storedRaw()).toBe(before);
  });
});

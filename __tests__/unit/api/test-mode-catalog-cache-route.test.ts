// __tests__/unit/api/test-mode-catalog-cache-route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";

vi.mock("@/lib/templates/cloud/client", () => ({ fetchIndex: vi.fn() }));
import { fetchIndex, type CatalogIndex } from "@/lib/templates/cloud/client";
import { getDb } from "@/lib/db/client";
import {
  catalogFetchedAt,
  catalogStatus,
  listCatalogEntries,
  refreshCatalogIfStale,
  replaceCatalog,
  resetCatalogRefreshForTests,
} from "@/lib/templates/cloud/catalog-cache";
import * as route from "@/app/api/test-mode/catalog-cache/route";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const A = "a".repeat(20);
const index: CatalogIndex = {
  schema: 1 as const,
  generatedAt: "x",
  usageRefreshedAt: null,
  base: "https://storage.googleapis.com/libi-prod-templates/",
  entries: [
    {
      id: A, name: "Kinetic hook", description: "desc", tags: ["hook"], nickname: "n", authorId: "a", version: 1, hasCode: false,
      canvas: { width: 1080, height: 1920 }, duration: 3, slotCount: 1, poster: `templates/${A}/v1/poster.jpg`, video: `templates/${A}/v1/example.mp4`,
      usesTotal: 1, uses7d: 1, heat: 0, heatAt: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
};

/** The rows as stored, whichever catalog they came from — not through the cache's own-copy filter. */
function stored(): { index: number; fts: number; meta: number } {
  const n = (q: ReturnType<typeof sql>) => getDb().get<{ n: number }>(q)?.n ?? 0;
  return {
    index: n(sql`SELECT count(*) AS n FROM catalog_index`),
    fts: n(sql`SELECT count(*) AS n FROM templates_fts WHERE scope = 'public'`),
    meta: n(sql`SELECT count(*) AS n FROM catalog_index_meta`),
  };
}

/** A local template (its FTS row comes from the insert trigger), and what of it is stored. */
function seedLocal(): void {
  getDb().run(sql`INSERT INTO templates (id, name, tags) VALUES ('local-1', 'Kinetic local', '[]')`);
}
function local(): { rows: unknown[]; fts: unknown[] } {
  return {
    rows: getDb().all(sql`SELECT id FROM templates`),
    fts: getDb().all(sql`SELECT ref_id, scope FROM templates_fts WHERE scope <> 'public'`),
  };
}
const LOCAL = { rows: [{ id: "local-1" }], fts: [{ ref_id: "local-1", scope: "local" }] };

/** A request whose body read is observable: a refusal must come before it. */
function request(m: string): { req: Request; read: () => boolean } {
  let read = false;
  const req = new Request("http://127.0.0.1:3465/api/test-mode/catalog-cache", { method: m === "HEAD" ? "GET" : m });
  Object.defineProperty(req, "method", { value: m });
  Object.defineProperty(req, "arrayBuffer", { value: async () => ((read = true), new ArrayBuffer(0)) });
  Object.defineProperty(req, "json", { value: async () => ((read = true), {}) });
  Object.defineProperty(req, "text", { value: async () => ((read = true), "") });
  return { req, read: () => read };
}

beforeEach(() => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", undefined);
  createTestDb();
});
afterEach(() => {
  resetCatalogRefreshForTests();
  resetTestDb();
  vi.mocked(fetchIndex).mockReset();
  vi.unstubAllEnvs();
});

describe("DELETE /api/test-mode/catalog-cache", () => {
  it("outside test mode: every method answers a bare 404 without reading the body, and the cached copy stays", async () => {
    replaceCatalog(index, '"1"', Date.now());
    const before = stored();
    expect(before).toEqual({ index: 1, fts: 1, meta: 1 });
    for (const env of ["0", "", undefined]) {
      vi.stubEnv("LIBI_TEST_MODE", env);
      // A method left out would get Next's own answer (OPTIONS 204 + Allow, or 405), which says the route exists.
      for (const m of METHODS) expect(typeof route[m], m).toBe("function");
      for (const m of METHODS) {
        const { req, read } = request(m);
        const res = await route[m](req);
        expect([env, m, res.status, await res.text(), read()]).toEqual([env, m, 404, "", false]);
      }
    }
    expect(stored()).toEqual(before);
    expect(listCatalogEntries()).toHaveLength(1);
  });

  it("in test mode: forgets the rows, their search mirror, the metadata and the backoff — the next read fetches as a first open", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    seedLocal();
    replaceCatalog(index, '"1"', Date.now());
    // A failed refresh leaves an error and a backoff behind it.
    vi.mocked(fetchIndex).mockResolvedValueOnce({ ok: false, error: "boom", reason: "http_error" });
    await refreshCatalogIfStale({ force: true });
    expect(catalogStatus().error).toBe("http_error");

    const res = await route.DELETE(request("DELETE").req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(stored()).toEqual({ index: 0, fts: 0, meta: 0 });
    // Never a local template, nor its search row: only the public scope goes.
    expect(local()).toEqual(LOCAL);
    expect(catalogFetchedAt()).toBeNull();
    expect(catalogStatus()).toEqual({ fetchedAt: null });

    // No backoff held over: a plain (non-forced) read goes to the network.
    vi.mocked(fetchIndex).mockResolvedValueOnce({ ok: true, notModified: false, etag: '"2"', index });
    expect(await refreshCatalogIfStale()).toEqual({ refreshed: true, entries: 1 });
    expect(vi.mocked(fetchIndex).mock.calls.at(-1)?.[0]).toEqual({ etag: null });
  });

  // A14 review M-R1: test mode shares LIBI_HOME with a normal boot.
  it("in test mode: a copy of the REAL site's catalog is never dropped — the next normal boot still has it, and every local template", async () => {
    seedLocal();
    replaceCatalog(index, '"1"', Date.now()); // a normal boot's copy of the site
    const before = stored();
    expect(before).toEqual({ index: 1, fts: 1, meta: 1 });

    vi.stubEnv("LIBI_TEST_MODE", "1");
    // A failed refresh in test mode leaves a backoff; the forget still clears that module state.
    vi.mocked(fetchIndex).mockResolvedValueOnce({ ok: false, error: "boom", reason: "http_error" });
    await refreshCatalogIfStale({ force: true });
    const res = await route.DELETE(request("DELETE").req);
    expect(res.status).toBe(200);
    expect(stored()).toEqual(before);
    expect(local()).toEqual(LOCAL);
    expect(catalogStatus()).toEqual({ fetchedAt: null }); // test mode reads that copy as none, as before
    vi.mocked(fetchIndex).mockResolvedValueOnce({ ok: false, error: "offline", reason: "unreachable" });
    await refreshCatalogIfStale();
    expect(fetchIndex).toHaveBeenCalledTimes(2); // no backoff held over

    vi.stubEnv("LIBI_TEST_MODE", undefined);
    expect(listCatalogEntries()).toHaveLength(1);
    expect(catalogFetchedAt()).not.toBeNull();
  });

  it("in test mode: any other method is a 405 that names DELETE, and changes nothing", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    replaceCatalog(index, '"1"', Date.now());
    for (const m of METHODS.filter((x) => x !== "DELETE")) {
      const res = await route[m](request(m).req);
      expect([m, res.status, res.headers.get("allow")]).toEqual([m, 405, "DELETE"]);
    }
    expect(stored()).toEqual({ index: 1, fts: 1, meta: 1 });
  });
});

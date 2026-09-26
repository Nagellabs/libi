// __tests__/unit/api/templates-cloud-catalog-route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";

vi.mock("@/lib/templates/cloud/client", () => ({ fetchIndex: vi.fn().mockResolvedValue({ ok: false, error: "offline", reason: "unreachable" }) }));
import { fetchIndex } from "@/lib/templates/cloud/client";
import { GET as GET_CATALOG, POST } from "@/app/api/templates/cloud/catalog/route";
import { noteOwnCatalogChange, resetCatalogRefreshForTests } from "@/lib/templates/cloud/catalog-cache";

const BASE = "https://storage.googleapis.com/libi-prod-templates/";
// The Templates page's own fetch by default; a header-less client (e2e's request context, curl) or another page's subresource on demand.
const catalogReq = (h: Record<string, string> = {}) => new Request("http://127.0.0.1:3461/api/templates/cloud/catalog", { headers: { host: "127.0.0.1:3461", ...h } });
const GET = (req: Request = catalogReq({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" })) => GET_CATALOG(req);
const ID = "abcdefghijklmnopqrst";
const ENTRY = {
  id: ID, name: "Hook", description: "", tags: ["hook", "promo"], nickname: "nadav", authorId: "a", version: 2, hasCode: false,
  canvas: { width: 1080, height: 1920 }, duration: 3, slotCount: 1, poster: `templates/${ID}/v2/poster.jpg`, video: `templates/${ID}/v2/example.mp4`,
  usesTotal: 3, uses7d: 1, heat: 0.5, heatAt: 1, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
};

beforeEach(() => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", undefined);
  vi.mocked(fetchIndex).mockClear();
  createTestDb();
});
afterEach(() => {
  resetCatalogRefreshForTests();
  resetTestDb();
  vi.unstubAllEnvs();
});

describe("GET /api/templates/cloud/catalog", () => {
  // T1 follow-up (2026-09-24): a read that may call the site and rewrite the cache refuses another page's subresource request.
  it("refuses a cross-site or same-site subresource request before it fetches anything", async () => {
    for (const site of ["cross-site", "same-site"]) {
      for (const mode of ["no-cors", "cors"]) {
        const res = await GET(catalogReq({ "sec-fetch-site": site, "sec-fetch-mode": mode }));
        expect(res.status, `${site} ${mode}`).toBe(403);
        expect((await res.json()).code).toBe("cross_site_read");
      }
    }
    expect(vi.mocked(fetchIndex)).not.toHaveBeenCalled();
  });

  it("answers the page's same-origin fetch and a header-less client", async () => {
    for (const req of [catalogReq({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }), catalogReq()]) {
      const res = await GET(req);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ entries: [] });
    }
    expect(vi.mocked(fetchIndex)).toHaveBeenCalled();
  });

  it("answers 200 with an empty list and the error when the site is unreachable — never 5xx", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ entries: [], fetchedAt: null, refreshed: false, error: "unreachable" });
  });

  it("lists the refreshed cache with parsed tags, the fetch time and the bucket base", async () => {
    vi.mocked(fetchIndex).mockResolvedValueOnce({
      ok: true, notModified: false, etag: '"1"',
      index: { schema: 1, generatedAt: "2026-09-23T00:00:00.000Z", usageRefreshedAt: null, base: BASE, entries: [ENTRY] },
    });
    const body = await (await GET()).json();
    expect(body).toMatchObject({ refreshed: true, base: BASE });
    expect(body.error).toBeUndefined();
    expect(Number.isNaN(Date.parse(body.fetchedAt))).toBe(false);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ cloudId: ID, tags: ["hook", "promo"], nickname: "nadav", poster: `templates/${ID}/v2/poster.jpg` });
    // Fresh now: a second GET serves the cache without another fetch.
    const again = await (await GET()).json();
    expect(again).toMatchObject({ refreshed: false, entries: [{ cloudId: ID }] });
    expect(vi.mocked(fetchIndex)).toHaveBeenCalledTimes(1);
  });

  it("POST (the Public tab's Refresh) forces a fetch past the failure backoff; GET waits the backoff out", async () => {
    // A failure starts the backoff: the next GET answers from the cache without trying.
    expect(await (await GET()).json()).toMatchObject({ error: "unreachable" });
    expect(await (await GET()).json()).toMatchObject({ error: "unreachable", refreshed: false });
    expect(vi.mocked(fetchIndex)).toHaveBeenCalledTimes(1);
    vi.mocked(fetchIndex).mockResolvedValueOnce({
      ok: true, notModified: false, etag: '"2"',
      index: { schema: 1, generatedAt: "2026-09-23T00:00:00.000Z", usageRefreshedAt: null, base: BASE, entries: [ENTRY] },
    });
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(vi.mocked(fetchIndex)).toHaveBeenCalledTimes(2);
    expect(body).toMatchObject({ refreshed: true, base: BASE, entries: [{ cloudId: ID }] });
    expect(body.error).toBeUndefined();
  });

  // A-F live check N1: the user's own publish showed nowhere until Refresh. Right after one, the GET
  // re-checks a copy it would otherwise call fresh, and hands the page what the copy doesn't show yet.
  it("after the user's own publish, a GET re-checks a fresh copy and answers the change until the copy lists it", async () => {
    const index = (entries: unknown[]) => ({ ok: true as const, notModified: false as const, etag: '"1"', index: { schema: 1 as const, generatedAt: "x", usageRefreshedAt: null, base: BASE, entries } as never });
    vi.mocked(fetchIndex).mockResolvedValueOnce(index([]));
    expect(await (await GET()).json()).toMatchObject({ entries: [], ownChanges: [] });
    await new Promise((r) => setTimeout(r, 2));
    noteOwnCatalogChange({ cloudId: ID, version: 2, kind: "published" });
    // The edge still serves the old index.
    vi.mocked(fetchIndex).mockResolvedValueOnce({ ok: true, notModified: true });
    const lagging = await (await GET()).json();
    expect(vi.mocked(fetchIndex)).toHaveBeenCalledTimes(2);
    expect(lagging).toMatchObject({ entries: [], ownChanges: [{ cloudId: ID, version: 2, kind: "published" }] });
    expect(Number.isNaN(Date.parse(lagging.ownChanges[0].at))).toBe(false);
    // The Refresh (or the next minute's GET) brings the new index: the change is gone from the answer.
    vi.mocked(fetchIndex).mockResolvedValueOnce(index([ENTRY]));
    expect(await (await POST()).json()).toMatchObject({ refreshed: true, entries: [{ cloudId: ID }], ownChanges: [] });
  });
});

// __tests__/unit/api/templates-cloud-catalog-detail-route.test.ts
//
// D5: GET /api/templates/cloud/catalog/<cloudId> — a public template's page
// data: the catalog's document, its scaffold (template.json alone, validated
// like an install's, never installed), where its media lives, and the local
// copy this machine already has.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeScaffold } from "@/__tests__/helpers/templates";

vi.mock("@/lib/templates/cloud/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/templates/cloud/client")>()),
  getCloudTemplate: vi.fn(),
}));
vi.mock("@/lib/templates/cloud/install", () => ({ fetchCatalogScaffold: vi.fn() }));
vi.mock("@/lib/templates/store", () => ({ findInstalledTemplate: vi.fn(() => null) }));

import { GET as GET_DETAIL } from "@/app/api/templates/cloud/catalog/[cloudId]/route";
import { getCloudTemplate, type CloudTemplate } from "@/lib/templates/cloud/client";
import { catalogRateLimitedFor, catalogStreamableAsset, resetCatalogScaffoldCacheForTests } from "@/lib/templates/cloud/catalog-detail";
import { fetchCatalogScaffold } from "@/lib/templates/cloud/install";
import { findInstalledTemplate } from "@/lib/templates/store";

const ID = "abcdefghijklmnopqrst";
const BASE = "https://storage.googleapis.com/libi-prod-templates/";

function doc(version = 1, over: Partial<CloudTemplate> = {}): CloudTemplate {
  return {
    id: ID, name: "Hook", description: "A hook.", tags: ["hook"], nickname: "nadav", authorId: "author-1", version, hasCode: false,
    canvas: { width: 1080, height: 1920 }, duration: 3, slotCount: 1, poster: `templates/${ID}/v${version}/poster.jpg`, video: `templates/${ID}/v${version}/example.mp4`,
    usesTotal: 9, uses7d: 2, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
    files: [], prefix: `templates/${ID}/v${version}/`, base: BASE, example: { durationSec: 3, width: 1080, height: 1920 },
    ...over,
  };
}

const req = (id: string, h: Record<string, string> = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }) =>
  new Request(`http://127.0.0.1:3461/api/templates/cloud/catalog/${id}`, { headers: { host: "127.0.0.1:3461", ...h } });
const GET = (id = ID, r = req(id)) => GET_DETAIL(r, { params: Promise.resolve({ cloudId: id }) });

beforeEach(() => {
  resetCatalogScaffoldCacheForTests();
  vi.mocked(getCloudTemplate).mockReset();
  vi.mocked(getCloudTemplate).mockResolvedValue({ ok: true, template: doc() });
  vi.mocked(fetchCatalogScaffold).mockReset();
  vi.mocked(fetchCatalogScaffold).mockResolvedValue({ scaffold: makeScaffold(), droppedAssets: 0 } as never);
  vi.mocked(findInstalledTemplate).mockReset();
  vi.mocked(findInstalledTemplate).mockReturnValue(null);
});
afterEach(() => vi.clearAllMocks());

describe("GET /api/templates/cloud/catalog/[cloudId]", () => {
  it("answers the document, the scaffold, the media base and no local copy", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toMatchObject({ id: ID, name: "Hook", version: 1, usesTotal: 9, uses7d: 2 });
    expect(body.scaffold).toEqual(makeScaffold());
    expect(body.mediaBase).toBe(`${BASE}templates/${ID}/v1/`);
    expect(body.installedTemplateId).toBeNull();
    expect(body.installedOrigin).toBeNull();
    expect(body.droppedAssets).toBe(0);
    expect(findInstalledTemplate).toHaveBeenCalledWith(ID);
  });

  it("names the local copy when this machine has one, and whether it is an installed copy or the user's own", async () => {
    vi.mocked(findInstalledTemplate).mockReturnValue({ id: "local-1", origin: "installed" });
    expect(await (await GET()).json()).toMatchObject({ installedTemplateId: "local-1", installedOrigin: "installed" });
    vi.mocked(findInstalledTemplate).mockReturnValue({ id: "mine-1", origin: "local" });
    expect(await (await GET()).json()).toMatchObject({ installedTemplateId: "mine-1", installedOrigin: "local" });
  });

  it("says how many assets were left out for failing the install's check (review I3)", async () => {
    vi.mocked(fetchCatalogScaffold).mockResolvedValueOnce({ scaffold: makeScaffold(), droppedAssets: 2 } as never);
    expect((await (await GET()).json()).droppedAssets).toBe(2);
  });

  it("concurrent views of one version share a single template.json download (review M7)", async () => {
    let finish: (v: unknown) => void = () => {};
    vi.mocked(fetchCatalogScaffold).mockImplementationOnce(() => new Promise((r) => (finish = r)) as never);
    const a = GET();
    const b = GET();
    await new Promise((r) => setTimeout(r, 10));
    finish({ scaffold: makeScaffold(), droppedAssets: 0 });
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect(fetchCatalogScaffold).toHaveBeenCalledTimes(1);
  });

  it("passes the site's 429 through as 429 rate_limited with its Retry-After — never a 502 to retry (review I2)", async () => {
    vi.mocked(getCloudTemplate).mockResolvedValue({ ok: false, error: "Too many requests.", status: 429, code: "rate_limited", retryAfterMs: 42_500 });
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("43");
    expect(await res.json()).toMatchObject({ code: "rate_limited", retryAfterSec: 43 });
    resetCatalogScaffoldCacheForTests(); // the backoff it set would answer the next GET itself
    vi.mocked(getCloudTemplate).mockResolvedValue({ ok: false, error: "Too many requests.", status: 429, code: "rate_limited" });
    const bare = await GET();
    expect(bare.status).toBe(429);
    expect(bare.headers.get("retry-after")).toBe("60");
  });

  it("serves a version's scaffold from memory the second time; a new version fetches again", async () => {
    await GET();
    await GET();
    expect(fetchCatalogScaffold).toHaveBeenCalledTimes(1);
    vi.mocked(getCloudTemplate).mockResolvedValue({ ok: true, template: doc(2) });
    const body = await (await GET()).json();
    expect(fetchCatalogScaffold).toHaveBeenCalledTimes(2);
    expect(body.mediaBase).toBe(`${BASE}templates/${ID}/v2/`);
  });

  it("refuses another page's subresource request before it calls the site", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = await GET(ID, req(ID, { "sec-fetch-site": site, "sec-fetch-mode": "no-cors" }));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("cross_site_read");
    }
    expect(getCloudTemplate).not.toHaveBeenCalled();
  });

  it("400 for an id that is not a catalog id", async () => {
    const res = await GET("../etc");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid");
    expect(getCloudTemplate).not.toHaveBeenCalled();
  });

  it("404 when the catalog says it has no such template (removed or hidden)", async () => {
    vi.mocked(getCloudTemplate).mockResolvedValue({ ok: false, error: "nope", status: 404, code: "not_found" });
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This template is no longer in the catalog.", code: "not_found" });
    vi.mocked(getCloudTemplate).mockResolvedValue({ ok: false, error: "gone", status: 410, code: "gone" });
    expect((await GET()).status).toBe(404);
  });

  it("502 unreachable when the site didn't answer, unavailable when it answered with an error", async () => {
    vi.mocked(getCloudTemplate).mockResolvedValue({ ok: false, error: "fetch failed" });
    let res = await GET();
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("unreachable");
    vi.mocked(getCloudTemplate).mockResolvedValue({ ok: false, error: "boom", status: 500 });
    res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("unavailable");
    // libi's own words, never the site's.
    expect(body.error).not.toContain("boom");
  });

  it("502 invalid_template when the scaffold is refused; nothing is cached", async () => {
    vi.mocked(fetchCatalogScaffold).mockRejectedValueOnce(new Error("template.json does not match the catalog (canvas)"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("invalid_template");
    expect((await GET()).status).toBe(200);
    expect(fetchCatalogScaffold).toHaveBeenCalledTimes(2);
  });

  it("after the site's 429 for ONE template, no template's page asks the site until Retry-After has passed — the limit is per client (fix-round N5)", async () => {
    vi.mocked(getCloudTemplate).mockResolvedValueOnce({ ok: false, error: "Too many requests.", status: 429, code: "rate_limited", retryAfterMs: 30_000 });
    expect((await GET()).status).toBe(429);
    vi.mocked(getCloudTemplate).mockClear();
    const other = "zzzzzzzzzzzzzzzzzzzz";
    const res = await GET(other);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(30);
    expect(getCloudTemplate).not.toHaveBeenCalled();
  });

  it("a template the catalog no longer has is forgotten: its media stops streaming (fix-round N4)", async () => {
    const withClip = { ...makeScaffold(), assets: [{ ref: "clip", kind: "video", url: "https://media.example.com/c.mp4" }] };
    vi.mocked(fetchCatalogScaffold).mockResolvedValue({ scaffold: withClip, droppedAssets: 0 } as never);
    expect((await GET()).status).toBe(200);
    expect(catalogStreamableAsset(ID, "https://media.example.com/c.mp4")).toEqual({ kind: "video" });
    vi.mocked(getCloudTemplate).mockResolvedValue({ ok: false, error: "nope", status: 404, code: "not_found" });
    expect((await GET()).status).toBe(404);
    expect(catalogStreamableAsset(ID, "https://media.example.com/c.mp4")).toBeNull();
  });

  it("caps an absurd Retry-After at 600 s — one bad header can't lock every page until a restart (confirmation review C2)", async () => {
    vi.mocked(getCloudTemplate).mockResolvedValueOnce({ ok: false, error: "slow", status: 429, code: "rate_limited", retryAfterMs: 999_999_999_000 });
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
    expect((await res.json()).retryAfterSec).toBe(600);
    expect(catalogRateLimitedFor()).toBeLessThanOrEqual(600_000);
    expect(catalogRateLimitedFor()).toBeGreaterThan(590_000);
  });
});

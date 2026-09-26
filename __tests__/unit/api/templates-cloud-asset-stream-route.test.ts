// __tests__/unit/api/templates-cloud-asset-stream-route.test.ts
//
// D5–D6 follow-up: GET /api/templates/cloud/asset-stream plays a public
// template's link-only audio/video inline. The route streams only an asset of
// a template whose page this process showed (its checked scaffold), refuses
// another site's request first, passes Range through, and logs the host —
// never the URL. The network is the fake one the SSRF tests use.
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeScaffold } from "@/__tests__/helpers/templates";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
vi.mock("@/lib/templates/cloud/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/templates/cloud/client")>()),
  getCloudTemplate: vi.fn(),
}));

vi.mock("@/lib/templates/cloud/install", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/templates/cloud/install")>()),
  fetchCatalogScaffold: vi.fn(),
}));

import { GET } from "@/app/api/templates/cloud/asset-stream/route";
import { GET as PAGE } from "@/app/api/templates/cloud/catalog/[cloudId]/route";
import { fetchCatalogScaffold } from "@/lib/templates/cloud/install";
import { getCloudTemplate } from "@/lib/templates/cloud/client";
import { serverLogger } from "@/lib/logger";
import { __setAssetStreamDepsForTests } from "@/lib/templates/cloud/asset-stream";
import {
  __primeCatalogScaffoldForTests,
  catalogRateLimitedFor,
  catalogScaffold,
  forgetCatalogTemplate,
  noteCatalogListed,
  noteCatalogRateLimited,
  resetCatalogScaffoldCacheForTests,
  STREAMABLE_FOR_MS,
} from "@/lib/templates/cloud/catalog-detail";

const ID = "abcdefghijklmnopqrst";
const CLIP = "https://media.example.com/clips/hook.mp4?token=secret-signature";
const SONG = "https://media.example.com/song.mp3";

const requests: Array<{ url: string; range?: string }> = [];
function network(dnsTable: Record<string, string>, reply: { status: number; headers: Record<string, string>; body: string }) {
  __setAssetStreamDepsForTests({
    lookup: async (h) => (dnsTable[h] ? [{ address: dnsTable[h], family: 4 }] : Promise.reject(new Error("ENOTFOUND"))),
    request: ((url: URL, opts: { headers: Record<string, string> }) => {
      requests.push({ url: url.href, range: opts.headers.range });
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => {};
      req.end = () => setImmediate(() => req.emit("response", Object.assign(Readable.from([Buffer.from(reply.body)]), { statusCode: reply.status, headers: reply.headers })));
      return req;
    }) as never,
  });
}
const get = (params: Record<string, string>, headers: Record<string, string> = { "sec-fetch-site": "same-origin", "sec-fetch-dest": "video" }) =>
  GET(new Request(`http://127.0.0.1:3461/api/templates/cloud/asset-stream?${new URLSearchParams(params)}`, { headers: { host: "127.0.0.1:3461", ...headers } }));

beforeEach(() => {
  resetCatalogScaffoldCacheForTests();
  vi.mocked(getCloudTemplate).mockReset();
  requests.length = 0;
  __primeCatalogScaffoldForTests(
    { id: ID, version: 2 },
    {
      scaffold: { ...makeScaffold(), assets: [{ ref: "clip", kind: "video", url: CLIP }, { ref: "song", kind: "audio", url: SONG }, { ref: "pic", kind: "image", url: "https://media.example.com/a.png" }] } as never,
      droppedAssets: 0,
    },
  );
});
afterEach(() => {
  __setAssetStreamDepsForTests(null);
  vi.restoreAllMocks();
});

describe("GET /api/templates/cloud/asset-stream", () => {
  it("streams a shown template's link-only video with the page's Range, as media: nosniff, no-store", async () => {
    network({ "media.example.com": "93.184.216.34" }, { status: 206, headers: { "content-type": "video/mp4", "content-length": "5", "content-range": "bytes 0-4/10", "accept-ranges": "bytes" }, body: "hello" });
    const info = vi.spyOn(serverLogger, "info");
    const res = await GET(
      new Request(`http://127.0.0.1:3461/api/templates/cloud/asset-stream?${new URLSearchParams({ cloudId: ID, url: CLIP })}`, {
        headers: { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin", range: "bytes=0-4", cookie: "session=1" },
      }),
    );
    expect(res.status).toBe(206);
    expect(Object.fromEntries(res.headers)).toMatchObject({ "content-type": "video/mp4", "content-range": "bytes 0-4/10", "accept-ranges": "bytes", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    expect(await res.text()).toBe("hello");
    expect(requests).toEqual([{ url: CLIP, range: "bytes=0-4" }]);
    // The host, never the URL: its query carries a signature.
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain("media.example.com");
    expect(logged).not.toContain("secret-signature");
    expect(logged).not.toContain("/clips/");
  });

  it("refuses another site's request before anything is fetched", async () => {
    network({ "media.example.com": "93.184.216.34" }, { status: 200, headers: { "content-type": "video/mp4" }, body: "x" });
    for (const site of ["cross-site", "same-site"]) {
      const res = await get({ cloudId: ID, url: CLIP }, { "sec-fetch-site": site, "sec-fetch-dest": "video" });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("cross_site_read");
    }
    expect(requests).toEqual([]);
  });

  it("streams nothing that isn't a shown template's audio/video asset: an unknown url, an image, another template, no page read yet", async () => {
    network({ "media.example.com": "93.184.216.34" }, { status: 200, headers: { "content-type": "video/mp4" }, body: "x" });
    for (const params of [
      { cloudId: ID, url: "https://media.example.com/other.mp4" },
      { cloudId: ID, url: "https://media.example.com/a.png" },
      { cloudId: "zzzzzzzzzzzzzzzzzzzz", url: CLIP },
    ]) {
      const res = await get(params);
      expect(res.status, JSON.stringify(params)).toBe(404);
      expect((await res.json()).code).toBe("not_an_asset");
    }
    for (const params of [{ cloudId: "../x", url: CLIP }, { cloudId: ID, url: "" }, { cloudId: ID, url: `https://media.example.com/${"a".repeat(3000)}` }]) {
      expect((await get(params)).status).toBe(400);
    }
    resetCatalogScaffoldCacheForTests();
    expect((await get({ cloudId: ID, url: CLIP })).status).toBe(404);
    expect(requests).toEqual([]);
  });

  it("answers the SSRF refusals in libi's words: a private address 403, the wrong type 415 — the upstream's body never reaches the page", async () => {
    network({ "media.example.com": "10.0.0.7" }, { status: 200, headers: { "content-type": "video/mp4" }, body: "internal secrets" });
    let res = await get({ cloudId: ID, url: CLIP });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "private_address" });
    network({ "media.example.com": "93.184.216.34" }, { status: 200, headers: { "content-type": "text/html" }, body: "<script>x</script>" });
    res = await get({ cloudId: ID, url: SONG });
    expect(res.status).toBe(415);
    const body = await res.text();
    expect(body).toContain("wrong_type");
    expect(body).not.toContain("<script>");
  });

  // Fix-round review N4: a template that left the catalog stops streaming.
  it("streams nothing once the catalog said the template is gone", async () => {
    network({ "media.example.com": "93.184.216.34" }, { status: 200, headers: { "content-type": "video/mp4" }, body: "x" });
    expect((await get({ cloudId: ID, url: CLIP })).status).toBe(200);
    forgetCatalogTemplate(ID);
    expect((await get({ cloudId: ID, url: CLIP })).status).toBe(404);
    expect(getCloudTemplate).not.toHaveBeenCalled();
  });

  // Confirmation review C1: Play on a page left open past the window re-asks the catalog ON DEMAND.
  describe("Play more than STREAMABLE_FOR_MS after the page confirmed the listing", () => {
    const stale = () =>
      __primeCatalogScaffoldForTests(
        { id: ID, version: 2 },
        { scaffold: { ...makeScaffold(), assets: [{ ref: "clip", kind: "video", url: CLIP }] } as never, droppedAssets: 0 },
        Date.now() - STREAMABLE_FOR_MS - 60_000,
      );
    const listedDoc = { id: ID, version: 2 } as never;

    it("still listed: asks the catalog once, streams, and the listing is fresh again (no further asks)", async () => {
      network({ "media.example.com": "93.184.216.34" }, { status: 200, headers: { "content-type": "video/mp4" }, body: "x" });
      stale();
      vi.mocked(getCloudTemplate).mockResolvedValue({ ok: true, template: listedDoc });
      expect((await get({ cloudId: ID, url: CLIP })).status).toBe(200);
      expect(getCloudTemplate).toHaveBeenCalledTimes(1);
      expect(getCloudTemplate).toHaveBeenCalledWith(ID);
      expect((await get({ cloudId: ID, url: CLIP })).status).toBe(200); // a seek a moment later
      expect(getCloudTemplate).toHaveBeenCalledTimes(1);
    });

    it("delisted meanwhile: refused as no longer in the catalog, forgotten, nothing fetched from the host", async () => {
      network({ "media.example.com": "93.184.216.34" }, { status: 200, headers: { "content-type": "video/mp4" }, body: "x" });
      stale();
      vi.mocked(getCloudTemplate).mockResolvedValue({ ok: false, error: "nope", status: 404, code: "not_found" });
      const res = await get({ cloudId: ID, url: CLIP });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "This template is no longer in the catalog.", code: "not_found" });
      expect(requests).toEqual([]);
      vi.mocked(getCloudTemplate).mockClear();
      expect((await get({ cloudId: ID, url: CLIP })).status).toBe(404);
      expect(getCloudTemplate).not.toHaveBeenCalled(); // forgotten: not even asked again
    });

    it("inside the per-client 429 backoff: 429 with the remaining Retry-After, without asking the catalog", async () => {
      stale();
      noteCatalogRateLimited(30_000);
      const res = await get({ cloudId: ID, url: CLIP });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(30);
      expect(getCloudTemplate).not.toHaveBeenCalled();
    });

    it("the catalog answering 429 with an absurd Retry-After is capped at 10 minutes (confirmation review C2)", async () => {
      stale();
      vi.mocked(getCloudTemplate).mockResolvedValue({ ok: false, error: "slow", status: 429, code: "rate_limited", retryAfterMs: 86_400_000 });
      const res = await get({ cloudId: ID, url: CLIP });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("600");
      expect(catalogRateLimitedFor()).toBeLessThanOrEqual(600_000);
    });

    it("a fresh listing streams without asking at all", async () => {
      network({ "media.example.com": "93.184.216.34" }, { status: 200, headers: { "content-type": "video/mp4" }, body: "x" });
      noteCatalogListed(ID, 2);
      expect((await get({ cloudId: ID, url: CLIP })).status).toBe(200);
      expect(getCloudTemplate).not.toHaveBeenCalled();
    });
  
    it("concurrent Range requests share ONE listing re-check (final review F2)", async () => {
      network({ "media.example.com": "93.184.216.34" }, { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-0/1" }, body: "x" });
      stale();
      let answer: (v: unknown) => void = () => {};
      vi.mocked(getCloudTemplate).mockImplementation(() => new Promise((r) => (answer = r)) as never);
      const three = [get({ cloudId: ID, url: CLIP }), get({ cloudId: ID, url: CLIP }), get({ cloudId: ID, url: CLIP })];
      await new Promise((r) => setTimeout(r, 10));
      answer({ ok: true, template: listedDoc });
      expect((await Promise.all(three)).map((r) => r.status)).toEqual([206, 206, 206]);
      expect(getCloudTemplate).toHaveBeenCalledTimes(1);
    });

    it("a new listed version replaces the old one's links: v1's link stops streaming, v2's streams (final review F4)", async () => {
      network({ "media.example.com": "93.184.216.34" }, { status: 200, headers: { "content-type": "video/mp4" }, body: "x" });
      stale(); // v2 cached, with CLIP
      const NEW = "https://media.example.com/fixed.mp4";
      vi.mocked(getCloudTemplate).mockResolvedValue({ ok: true, template: { id: ID, version: 3 } as never });
      vi.mocked(fetchCatalogScaffold).mockResolvedValue({ scaffold: { ...makeScaffold(), assets: [{ ref: "clip", kind: "video", url: NEW }] }, droppedAssets: 0 } as never);
      // The re-check finds v3 listed and reads its scaffold: the old link is not in it.
      expect((await get({ cloudId: ID, url: CLIP })).status).toBe(404);
      expect((await get({ cloudId: ID, url: NEW })).status).toBe(200);
      expect(getCloudTemplate).toHaveBeenCalledTimes(1);
      expect(await catalogScaffold({ id: ID, version: 2 } as never)).toBeTruthy(); // v2 still cached, yet not streamable
      expect((await get({ cloudId: ID, url: CLIP })).status).toBe(404);
    });

    it("a 429 on the stream's re-check holds back re-checks for its (capped) Retry-After but never blocks a page load", async () => {
      stale();
      vi.mocked(getCloudTemplate).mockResolvedValueOnce({ ok: false, error: "slow", status: 429, code: "rate_limited", retryAfterMs: 45_000 });
      const res = await get({ cloudId: ID, url: CLIP });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("45"); // the site's own value, not a blanket 10 minutes
      expect(catalogRateLimitedFor()).toBe(0); // the page backoff is untouched…
      vi.mocked(getCloudTemplate).mockResolvedValue({ ok: true, template: listedDoc });
      vi.mocked(fetchCatalogScaffold).mockResolvedValue({ scaffold: makeScaffold(), droppedAssets: 0 } as never);
      createTestDb(); // the page route looks up a local copy
      const page = await PAGE(
        new Request(`http://127.0.0.1:3461/api/templates/cloud/catalog/${ID}`, { headers: { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin" } }),
        { params: Promise.resolve({ cloudId: ID }) },
      );
      expect(page.status).not.toBe(429); // …so the page still loads
      expect(getCloudTemplate).toHaveBeenCalledTimes(2);
      resetTestDb();
    });
  });
});

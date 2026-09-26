// A dev build switching catalogs: a public template's page cache, the stream
// route's listing confirmations, the re-confirmation in flight and both 429
// backoffs are kept per catalog (lib/templates/cloud/catalog-detail.ts).
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
import { setTemplatesCatalogSetting } from "@/lib/db/settings";
import { getCloudTemplate } from "@/lib/templates/cloud/client";
import { fetchCatalogScaffold } from "@/lib/templates/cloud/install";
import { __resetDevBuildForTests } from "@/lib/templates/cloud/catalog-setting";
import { catalogSource } from "@/lib/templates/cloud/catalog-source";
import {
  STREAMABLE_FOR_MS,
  __primeCatalogScaffoldForTests,
  catalogRateLimitedFor,
  catalogStreamableAsset,
  confirmStreamableAsset,
  forgetCatalogTemplate,
  noteCatalogRateLimited,
  resetCatalogScaffoldCacheForTests,
  streamRateLimitedFor,
} from "@/lib/templates/cloud/catalog-detail";

const DEV = "http://localhost:3300";
const PROD = "https://libi.nagellabs.com";
const ID = "abcdefghijklmnopqrst";
const CLIP = "https://media.example.com/clip.mp4";
const use = (choice: "production" | "development") => setTemplatesCatalogSetting({ choice, devOrigin: DEV, bypassToken: null });
const prime = (listed = Date.now()) =>
  __primeCatalogScaffoldForTests({ id: ID, version: 1 }, { scaffold: { ...makeScaffold(), assets: [{ ref: "clip", kind: "video", url: CLIP }] } as never, droppedAssets: 0 }, listed);

beforeEach(() => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", undefined);
  createTestDb();
  __resetDevBuildForTests();
  resetCatalogScaffoldCacheForTests();
  vi.mocked(getCloudTemplate).mockReset();
});
afterEach(() => {
  resetCatalogScaffoldCacheForTests();
  resetTestDb();
  vi.unstubAllEnvs();
});

describe("public template pages, per catalog", () => {
  it("a template shown under Development streams nothing under Production, and is still there after switching back", () => {
    use("development");
    prime();
    expect(catalogStreamableAsset(ID, CLIP)).toEqual({ kind: "video" });
    use("production");
    expect(catalogStreamableAsset(ID, CLIP)).toBeNull();
    forgetCatalogTemplate(ID); // production's "gone" is not development's
    use("development");
    expect(catalogStreamableAsset(ID, CLIP)).toEqual({ kind: "video" });
  });

  it("each catalog's rate limit is its own: a 429 from one never holds the other back", () => {
    use("development");
    noteCatalogRateLimited(30_000);
    expect(catalogRateLimitedFor()).toBeGreaterThan(0);
    expect(streamRateLimitedFor()).toBeGreaterThan(0);
    use("production");
    expect(catalogRateLimitedFor()).toBe(0);
    expect(streamRateLimitedFor()).toBe(0);
  });

  it("a stale listing is re-asked of the catalog it was shown from, even when the user switches mid-ask", async () => {
    use("development");
    prime(Date.now() - STREAMABLE_FOR_MS - 1);
    const askedOf: string[] = [];
    let answer!: (v: Awaited<ReturnType<typeof getCloudTemplate>>) => void;
    vi.mocked(getCloudTemplate).mockImplementationOnce(() => {
      askedOf.push(catalogSource());
      return new Promise((r) => (answer = r));
    });
    vi.mocked(fetchCatalogScaffold).mockImplementation(async () => ({ scaffold: { ...makeScaffold(), assets: [{ ref: "clip", kind: "video", url: CLIP }] } as never, droppedAssets: 0 }));
    const gate = confirmStreamableAsset(ID, CLIP);
    use("production");
    answer({ ok: true, template: { id: ID, version: 1 } as never });
    expect(await gate).toEqual({ ok: true, kind: "video" });
    expect(askedOf).toEqual([DEV]);
    // The fresh confirmation landed under Development, not Production.
    expect(catalogStreamableAsset(ID, CLIP)).toBeNull();
    use("development");
    expect(catalogStreamableAsset(ID, CLIP)).toEqual({ kind: "video" });
    void PROD;
  });
});

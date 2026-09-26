import { afterEach, describe, expect, it, vi } from "vitest";

async function freshConstants() {
  vi.resetModules();
  return import("@/lib/templates/cloud/constants");
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("catalogBucketBase", () => {
  it("is keyed by the CATALOG: the prod bucket for the production site, the dev bucket for any other site", async () => {
    const c = await freshConstants();
    expect(c.catalogBucketBase("https://libi.nagellabs.com")).toBe("https://storage.googleapis.com/libi-prod-templates/");
    expect(c.catalogBucketBase("http://localhost:3300")).toBe("https://storage.googleapis.com/libi-dev-templates/");
    expect(c.catalogBucketBase("https://libi-site-git-x-team.vercel.app")).toBe("https://storage.googleapis.com/libi-dev-templates/");
  });
  it("does not follow the build-time site url: a dev build switched to Production reads the production bucket", async () => {
    vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", "http://localhost:3300");
    const c = await freshConstants();
    expect(c.catalogBucketBase("https://libi.nagellabs.com")).toBe("https://storage.googleapis.com/libi-prod-templates/");
  });
  it("for the test-mode source is the studio's own fixture bucket route", async () => {
    const c = await freshConstants();
    expect(c.catalogBucketBase(c.TEST_MODE_SOURCE, 3465)).toBe("http://127.0.0.1:3465/api/test-mode/templates-catalog/bucket/");
  });
  it("for the test-mode source without the studio port throws instead of reaching a real bucket", async () => {
    const c = await freshConstants();
    expect(() => c.catalogBucketBase(c.TEST_MODE_SOURCE)).toThrow(/studio port/);
  });
  it("for a site ignores the studio port", async () => {
    const c = await freshConstants();
    expect(c.catalogBucketBase("https://libi.nagellabs.com", 3465)).toBe("https://storage.googleapis.com/libi-prod-templates/");
  });
  it("PUBLIC_CODE_TEMPLATES is off and the caps match the spec", async () => {
    const c = await freshConstants();
    expect(c.PUBLIC_CODE_TEMPLATES).toBe(false);
    expect(c.CAPS).toEqual({ image: 2 * 1024 * 1024, font: 4 * 1024 * 1024, code: 128 * 1024, scaffold: 256 * 1024, instructions: 32 * 1024, example: 8 * 1024 * 1024, poster: 400 * 1024, total: 24 * 1024 * 1024 });
    expect(c.MAX_FILES).toBe(60);
    expect(c.CLOUD_ID_PATTERN.test("abcdefghijklmnopqrst")).toBe(true);
    expect(c.CLOUD_ID_PATTERN.test("6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b")).toBe(false);
  });
});

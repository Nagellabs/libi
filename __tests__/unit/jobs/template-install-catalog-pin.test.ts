// __tests__/unit/jobs/template-install-catalog-pin.test.ts
//
// A dev build can switch templates catalogs in Settings. An install keeps the
// catalog it was QUEUED on (review M2): a switch between the enqueue and the
// job's start never sends it to the other catalog, where the id means nothing
// (`not_found`). A queued catalog this build can no longer reach — the
// development address changed meanwhile — fails with libi's words and asks
// neither catalog anything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";

/** The fake catalog client: the catalog each install asked, as `catalogSource()` answered inside the install. */
const asked = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/templates/cloud/install", async () => {
  const { catalogSource } = await import("@/lib/templates/cloud/catalog-source");
  return {
    installTemplate: vi.fn(async () => {
      asked.push(catalogSource());
      await new Promise((r) => setTimeout(r, 1));
      asked.push(catalogSource());
      return { ok: true, templateId: "t1", version: 1, reinstalled: false };
    }),
  };
});

import { templateInstallRunner, type TemplateInstallParams } from "@/lib/jobs/runners/template-install";
import type { JobContext } from "@/lib/jobs/types";
import { setTemplatesCatalogSetting } from "@/lib/db/settings";
import { __resetDevBuildForTests, activeCatalogSource } from "@/lib/templates/cloud/catalog-setting";

const PROD = "https://libi.nagellabs.com";
const DEV = "https://libi-site-git-templates-nagellabs.vercel.app";
const OTHER_DEV = "https://libi-site-git-other-nagellabs.vercel.app";
const ID = "abcdefghijklmnopqrst";

function ctx(params: unknown): JobContext<TemplateInstallParams> {
  return {
    jobId: "job-1",
    params: templateInstallRunner.paramsSchema.parse(params),
    resumeState: null,
    reportProgress: vi.fn(),
    checkpoint: vi.fn(async () => undefined),
    shouldCancel: () => false,
  };
}

beforeEach(() => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", undefined);
  vi.stubEnv("LIBI_RUNTIME_SOURCE", undefined);
  __resetDevBuildForTests();
  createTestDb();
  asked.length = 0;
});
afterEach(() => {
  resetTestDb();
  vi.unstubAllEnvs();
  __resetDevBuildForTests();
});

describe("template_install keeps the catalog it was queued on", () => {
  it("takes the catalog as a param: stable, so two installs of one template on one catalog still share a key", () => {
    const schema = templateInstallRunner.paramsSchema;
    expect(schema.parse({ cloudId: ID, source: DEV })).toEqual({ cloudId: ID, source: DEV });
    expect(schema.safeParse({ cloudId: ID, source: "" }).success).toBe(false);
  });

  it("queued on Development, the address then replaced and Production chosen: fails with libi's words, and asks no catalog", async () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    const queued = { cloudId: ID, source: activeCatalogSource() };
    expect(queued.source).toBe(DEV);
    // The switch lands before the job starts: Production, and the development address is no longer DEV.
    setTemplatesCatalogSetting({ choice: "production", devOrigin: OTHER_DEV, bypassToken: null });
    const run = templateInstallRunner.run(ctx(queued));
    await expect(run).rejects.toThrow(
      "The templates catalog changed since this was queued (was libi-site-git-templates-nagellabs.vercel.app, now libi.nagellabs.com). Ask again.",
    );
    // Its own code, so the Templates page says so in libi's words (review m5).
    await expect(run).rejects.toMatchObject({ name: "TemplateInstallError", code: "catalog_changed" });
    expect(asked).toEqual([]);
  });

  it("queued on Development, then switched to Production with the address kept: the install still goes to Development only", async () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    const queued = { cloudId: ID, source: activeCatalogSource() };
    setTemplatesCatalogSetting({ choice: "production", devOrigin: DEV, bypassToken: null });
    await templateInstallRunner.run(ctx(queued));
    expect(asked).toEqual([DEV, DEV]);
    expect(asked).not.toContain(PROD);
  });

  it("queued and run on one catalog: that catalog only, even across a switch made while it runs", async () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    const run = templateInstallRunner.run(ctx({ cloudId: ID, source: activeCatalogSource() }));
    setTemplatesCatalogSetting({ choice: "production", devOrigin: null, bypassToken: null });
    await run;
    expect(asked).toEqual([DEV, DEV]);
  });

  it("a packaged build refuses a queued catalog that isn't its own: a param never steers it elsewhere", async () => {
    vi.stubEnv("LIBI_RUNTIME_SOURCE", "bundled");
    __resetDevBuildForTests();
    await expect(templateInstallRunner.run(ctx({ cloudId: ID, source: DEV }))).rejects.toThrow(/catalog changed since this was queued/);
    expect(asked).toEqual([]);
    await templateInstallRunner.run(ctx({ cloudId: ID, source: PROD }));
    expect(asked).toEqual([PROD, PROD]);
  });

  it("a job queued before the catalog was a param (no `source`) runs on the active catalog, as it always did", async () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    await templateInstallRunner.run(ctx({ cloudId: ID }));
    expect(asked).toEqual([DEV, DEV]);
  });
});

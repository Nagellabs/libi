// __tests__/unit/templates/catalog-setting-memo.test.ts
//
// A dev build reads its templates catalog setting (SQLite + JSON + URL parse)
// through `catalogSource()`, which a listing calls once per template (review
// M7). The read is remembered: a switch made in this process is seen at once,
// and one made by another process (the studio vs the MCP child, both on the
// one settings row) within a second.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/db/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db/settings")>();
  return {
    ...real,
    getTemplatesCatalogSetting: () => {
      reads.count++;
      return real.getTemplatesCatalogSetting();
    },
  };
});

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema/sqlite";
import { setTemplatesCatalogSetting } from "@/lib/db/settings";
import { __resetDevBuildForTests, bypassHeadersFor } from "@/lib/templates/cloud/catalog-setting";
import { catalogSource, otherCatalogOf } from "@/lib/templates/cloud/catalog-source";

const PROD = "https://libi.nagellabs.com";
const DEV = "https://libi-site-git-templates-nagellabs.vercel.app";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

/** Another process's write: straight to the row, as the MCP child's (or the studio's) own settings module would. */
function writeFromAnotherProcess(value: object, at: Date): void {
  getDb().update(settings).set({ templatesCatalog: JSON.stringify(value), updatedAt: at }).where(eq(settings.id, 1)).run();
}

beforeEach(() => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", undefined);
  vi.stubEnv("LIBI_RUNTIME_SOURCE", undefined);
  __resetDevBuildForTests();
  createTestDb();
  reads.count = 0;
});
afterEach(() => {
  vi.useRealTimers();
  resetTestDb();
  vi.unstubAllEnvs();
  __resetDevBuildForTests();
});

describe("the templates catalog setting is read once per change, not once per template", () => {
  it("100 catalogSource() calls — a listing's otherCatalogOf per row, and the client's bypass check — read the setting at most twice", () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: TOKEN });
    reads.count = 0;
    for (let i = 0; i < 100; i++) {
      expect(catalogSource()).toBe(DEV);
      expect(otherCatalogOf({ cloudId: "abcdefghijklmnopqrst", publishPending: null, cloudSource: DEV })).toBeNull();
      expect(bypassHeadersFor(`${DEV}/api/templates/index`)).toEqual({ "x-vercel-protection-bypass": TOKEN });
    }
    expect(reads.count).toBeLessThanOrEqual(2);
  });

  it("a switch made in this process is seen at once", () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    expect(catalogSource()).toBe(DEV);
    setTemplatesCatalogSetting({ choice: "production", devOrigin: DEV, bypassToken: null });
    expect(catalogSource()).toBe(PROD);
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: TOKEN });
    expect(catalogSource()).toBe(DEV);
    expect(bypassHeadersFor(`${DEV}/api/templates/index`)).toEqual({ "x-vercel-protection-bypass": TOKEN });
  });

  it("a switch made by another process (a direct write that bumps updated_at) is seen within a second", () => {
    vi.useFakeTimers({ now: new Date("2026-10-02T10:00:00.000Z") });
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    expect(catalogSource()).toBe(DEV);
    // In the SAME second as the read above: an updated_at stamp (whole seconds) alone could not tell.
    writeFromAnotherProcess({ choice: "production", devOrigin: DEV, bypassToken: null }, new Date());
    vi.advanceTimersByTime(1000);
    expect(catalogSource()).toBe(PROD);
    writeFromAnotherProcess({ choice: "development", devOrigin: DEV, bypassToken: null }, new Date(Date.now() + 5000));
    vi.advanceTimersByTime(1000);
    expect(catalogSource()).toBe(DEV);
  });

  it("a fresh database (a DB reset, or the next test) is never answered from the old one's memory", () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    expect(catalogSource()).toBe(DEV);
    resetTestDb();
    createTestDb();
    expect(catalogSource()).toBe(PROD);
  });
});

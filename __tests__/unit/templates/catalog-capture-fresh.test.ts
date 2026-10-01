// __tests__/unit/templates/catalog-capture-fresh.test.ts
//
// The catalog setting is remembered for up to a second (CAT-3), and a switch
// made by ANOTHER process — the studio writes it, the MCP child reads it — is
// seen within that. What only READS may answer from that memory. What queues
// work on a catalog, or decides which one a job runs on, reads the setting
// fresh (review m2): `libi.publish_template` and `libi.apply_template` in the
// MCP child, the Templates page's install route, and a job's check at start.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";

const jobCalls = vi.hoisted(() => [] as Array<{ kind: string; params: Record<string, unknown> }>);
vi.mock("@/mcp/jobs-client", () => ({
  LibiServerUnavailableError: class extends Error {
    readonly hint = "start libi";
  },
  enqueueJobOnServer: vi.fn(),
  runJobViaServer: vi.fn(async (kind: string, params: Record<string, unknown>) => {
    jobCalls.push({ kind, params });
    throw new Error("stopped here by the test");
  }),
}));
const gateSaw = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/templates/cloud/creator", async () => {
  const { catalogSource } = await import("@/lib/templates/cloud/catalog-source");
  return {
    checkCreatorApproved: vi.fn(async () => {
      gateSaw.push(catalogSource());
      return { ok: true };
    }),
  };
});
vi.mock("@/lib/templates/cloud/publish-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/templates/cloud/publish-requests")>()),
  checkPublishRequestable: vi.fn(async () => ({ ok: true })),
}));
const jobManager = vi.hoisted(() => ({ enqueue: vi.fn(), runToCompletion: vi.fn() }));
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => jobManager }));
vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: vi.fn() } }));
vi.mock("@/lib/templates/cloud/install", () => ({ installTemplate: vi.fn(async () => ({ ok: true, templateId: "t1", version: 1, reinstalled: false })) }));

import { eq } from "drizzle-orm";
import { POST as INSTALL } from "@/app/api/templates/cloud/install/route";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema/sqlite";
import { setTemplatesCatalogSetting } from "@/lib/db/settings";
import { templateInstallRunner } from "@/lib/jobs/runners/template-install";
import type { JobContext } from "@/lib/jobs/types";
import { __resetDevBuildForTests } from "@/lib/templates/cloud/catalog-setting";
import { catalogSource } from "@/lib/templates/cloud/catalog-source";
import { publishTemplate } from "@/mcp/tools/template-cloud-tools";
import { applyTemplate } from "@/mcp/tools/template-tools";

const PROD = "https://libi.nagellabs.com";
const DEV = "https://libi-site-git-templates-nagellabs.vercel.app";
const OTHER_DEV = "https://libi-site-git-other-nagellabs.vercel.app";
const ID = "abcdefghijklmnopqrst";

/** The other process's write: straight to the row, so this process's memo is not told. */
function switchElsewhere(value: { choice: "production" | "development"; devOrigin: string | null }): void {
  getDb().update(settings).set({ templatesCatalog: JSON.stringify({ ...value, bypassToken: null }) }).where(eq(settings.id, 1)).run();
}

beforeEach(() => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", undefined);
  vi.stubEnv("LIBI_RUNTIME_SOURCE", undefined);
  __resetDevBuildForTests();
  createTestDb();
  jobCalls.length = 0;
  gateSaw.length = 0;
  jobManager.enqueue.mockReset().mockResolvedValue({ status: "new", jobId: "job-1", clientKey: "k", forced: true });
  jobManager.runToCompletion.mockReset().mockResolvedValue({ templateId: "t1", version: 1, reinstalled: false });
  // This process last read Development, and remembers it.
  setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
  expect(catalogSource()).toBe(DEV);
});
afterEach(() => {
  resetTestDb();
  vi.unstubAllEnvs();
  __resetDevBuildForTests();
});

describe("what queues work on a catalog reads the setting fresh (review m2)", () => {
  it("a pure read may still answer from the memo for up to a second", () => {
    switchElsewhere({ choice: "production", devOrigin: DEV });
    expect(catalogSource()).toBe(DEV);
  });

  it("libi.publish_template: the creator check and the queued prepare both use the catalog chosen a moment ago", async () => {
    switchElsewhere({ choice: "production", devOrigin: DEV });
    const r = await publishTemplate({ templateId: "t1", exampleVideo: { path: "/tmp/a.mp4" } } as never);
    expect(r.success).toBe(false);
    expect(gateSaw).toEqual([PROD]);
    expect(jobCalls).toEqual([{ kind: "template_publish_prepare", params: expect.objectContaining({ source: PROD }) }]);
  });

  it("libi.apply_template({ cloudId }): the install is queued on the catalog chosen a moment ago", async () => {
    switchElsewhere({ choice: "production", devOrigin: DEV });
    await applyTemplate({ cloudId: ID, newPiece: {} } as never);
    expect(jobCalls).toEqual([{ kind: "template_install", params: { cloudId: ID, source: PROD } }]);
  });

  it("the Templates page's install route queues on the catalog chosen a moment ago", async () => {
    switchElsewhere({ choice: "production", devOrigin: DEV });
    const res = await INSTALL(new Request("http://127.0.0.1/api/templates/cloud/install", { method: "POST", body: JSON.stringify({ cloudId: ID }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(200);
    expect(jobManager.enqueue).toHaveBeenCalledWith("template_install", { cloudId: ID, source: PROD }, expect.anything());
  });

  it("a job's check at start sees an address replaced a moment ago, and refuses the old one", async () => {
    switchElsewhere({ choice: "production", devOrigin: OTHER_DEV });
    const ctx: JobContext<never> = {
      jobId: "job-1",
      params: templateInstallRunner.paramsSchema.parse({ cloudId: ID, source: DEV }) as never,
      resumeState: null,
      reportProgress: () => undefined,
      checkpoint: async () => undefined,
      shouldCancel: () => false,
    };
    await expect(templateInstallRunner.run(ctx)).rejects.toMatchObject({ code: "catalog_changed" });
  });
});

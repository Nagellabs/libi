// __tests__/unit/jobs/template-publish-prepare-catalog-pin.test.ts
//
// A dev build can switch templates catalogs in Settings. A publish preparation
// keeps the catalog it was QUEUED on (review M2): the request it records
// belongs to that catalog, whatever the user switched to before the job
// started. A queued catalog this build can no longer reach fails with libi's
// words and records nothing. Against the real store and preflight, with ffmpeg
// replaced and the catalog client a recorder that fails the run on any call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";

/** The fake catalog client: every call, by the catalog it went to. The prepare job must never call it. */
const clientCalls = vi.hoisted(() => [] as Array<{ fn: string; source: string }>);
vi.mock("@/lib/templates/cloud/client", async () => {
  const { catalogSource } = await import("@/lib/templates/cloud/catalog-source");
  return new Proxy(
    {},
    {
      get: (_t, name) =>
        name === "then"
          ? undefined
          : () => {
              clientCalls.push({ fn: String(name), source: catalogSource() });
              throw new Error(`called the catalog: ${String(name)}`);
            },
    },
  );
});
vi.mock("@/lib/templates/cloud/publish-media", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.fakePublishMedia()));

import { getDb } from "@/lib/db/client";
import { templatePublishRequests } from "@/lib/db/schema/sqlite";
import { getOrCreateTemplatesAuthor, setTemplatesAuthorNickname, setTemplatesCatalogSetting } from "@/lib/db/settings";
import { templatePublishPrepareRunner } from "@/lib/jobs/runners/template-publish-prepare";
import type { JobContext } from "@/lib/jobs/types";
import { __resetDevBuildForTests, activeCatalogSource } from "@/lib/templates/cloud/catalog-setting";
import { createTemplate } from "@/lib/templates/store";

const PROD = "https://libi.nagellabs.com";
const DEV = "https://libi-site-git-templates-nagellabs.vercel.app";
const OTHER_DEV = "https://libi-site-git-other-nagellabs.vercel.app";

let home = "";
let src = "";
let templateId = "";

function ctx(params: unknown): JobContext<never> {
  return {
    jobId: "prepare-1",
    params: templatePublishPrepareRunner.paramsSchema.parse(params) as never,
    resumeState: null,
    reportProgress: () => undefined,
    checkpoint: async () => undefined,
    shouldCancel: () => false,
  };
}
const requests = () => getDb().select({ id: templatePublishRequests.id, source: templatePublishRequests.source }).from(templatePublishRequests).all();

beforeEach(async () => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", undefined);
  vi.stubEnv("LIBI_RUNTIME_SOURCE", undefined);
  __resetDevBuildForTests();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-prepare-pin-"));
  vi.stubEnv("LIBI_HOME", home);
  createTestDb();
  clientCalls.length = 0;
  src = path.join(home, "source.mp4");
  fs.writeFileSync(src, "x");
  const t = await createTemplate({
    name: "Hook + caption",
    description: "Three seconds.",
    tags: ["hook", "caption"],
    scaffold: makeScaffold({ name: "Hook + caption", description: "Three seconds.", tags: ["hook", "caption"] }) as never,
    instructions: "# Purpose\nA hook.\n",
    copies: [],
    writes: [],
  });
  templateId = t.id;
  setTemplatesAuthorNickname(getOrCreateTemplatesAuthor().key, "nadav");
});
afterEach(() => {
  resetTestDb();
  vi.unstubAllEnvs();
  __resetDevBuildForTests();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("template_publish_prepare keeps the catalog it was queued on", () => {
  it("takes the catalog as a param", () => {
    const parse = (p: unknown) => templatePublishPrepareRunner.paramsSchema.safeParse(p).success;
    expect(parse({ templateId: "t", exampleVideo: { path: "/a.mp4" }, source: DEV })).toBe(true);
    expect(parse({ templateId: "t", exampleVideo: { path: "/a.mp4" }, source: "" })).toBe(false);
  });

  it("queued on Development, the address then replaced and Production chosen: fails with libi's words, records nothing, asks no catalog", async () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    const queued = { templateId, exampleVideo: { path: src }, source: activeCatalogSource() };
    setTemplatesCatalogSetting({ choice: "production", devOrigin: OTHER_DEV, bypassToken: null });
    await expect(templatePublishPrepareRunner.run(ctx(queued))).rejects.toThrow(
      "The templates catalog changed since this was queued (was libi-site-git-templates-nagellabs.vercel.app, now libi.nagellabs.com). Ask again.",
    );
    expect(requests()).toEqual([]);
    expect(clientCalls).toEqual([]);
  });

  it("queued on Development, then switched to Production with the address kept: the request is Development's", async () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    const queued = { templateId, exampleVideo: { path: src }, source: activeCatalogSource() };
    setTemplatesCatalogSetting({ choice: "production", devOrigin: DEV, bypassToken: null });
    const r = await templatePublishPrepareRunner.run(ctx(queued));
    expect(requests()).toEqual([{ id: r.requestId, source: DEV }]);
    expect(clientCalls).toEqual([]);
  });

  it("queued and run on Production: the request is Production's", async () => {
    setTemplatesCatalogSetting({ choice: "production", devOrigin: DEV, bypassToken: null });
    const r = await templatePublishPrepareRunner.run(ctx({ templateId, exampleVideo: { path: src }, source: activeCatalogSource() }));
    expect(requests()).toEqual([{ id: r.requestId, source: PROD }]);
    expect(clientCalls).toEqual([]);
  });

  it("a job queued before the catalog was a param (no `source`) records the active catalog, as it always did", async () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    const r = await templatePublishPrepareRunner.run(ctx({ templateId, exampleVideo: { path: src } }));
    expect(requests()).toEqual([{ id: r.requestId, source: DEV }]);
  });
});

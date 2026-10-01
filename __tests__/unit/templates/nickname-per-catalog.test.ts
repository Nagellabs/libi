// __tests__/unit/templates/nickname-per-catalog.test.ts
//
// Each templates catalog keeps its own `authors/<id>` nickname, and a dev build
// can switch catalogs (review M4). The local nickname is PRODUCTION's (test
// mode's own row: the fixture's); every other catalog's nickname is cached in
// its own slot of the same settings row. So a nickname learned from, or set
// on, a development catalog is never shown as — or sent to production as — the
// public name: a first publish on Production sends Production's own nickname
// or the default, never another catalog's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";

vi.mock("@/lib/templates/cloud/client", () => ({ fetchMine: vi.fn(), setNickname: vi.fn() }));
vi.mock("@/lib/templates/cloud/publish-media", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.fakePublishMedia()));

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema/sqlite";
import { GET as GET_AUTHOR, PUT as PUT_AUTHOR } from "@/app/api/templates/cloud/author/route";
import { GET as GET_MINE } from "@/app/api/templates/cloud/mine/route";
import { getOrCreateTemplatesAuthor, getTemplatesAuthor, getTemplatesAuthorForDisplay, setTemplatesAuthorNickname, setTemplatesCatalogSetting } from "@/lib/db/settings";
import { templatePublishPrepareRunner } from "@/lib/jobs/runners/template-publish-prepare";
import type { JobContext } from "@/lib/jobs/types";
import { __resetDevBuildForTests } from "@/lib/templates/cloud/catalog-setting";
import { catalogSource } from "@/lib/templates/cloud/catalog-source";
import { fetchMine, setNickname } from "@/lib/templates/cloud/client";
import { createTemplate } from "@/lib/templates/store";

const PROD = "https://libi.nagellabs.com";
const DEV = "https://libi-site-git-templates-nagellabs.vercel.app";
const ORIGIN = "http://127.0.0.1:3461";
const sameOrigin = { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
const MINE = () => GET_MINE(new Request(`${ORIGIN}/api/templates/cloud/mine`, { headers: sameOrigin }));
const AUTHOR = async () => (await GET_AUTHOR(new Request(`${ORIGIN}/api/templates/cloud/author`, { headers: sameOrigin }))).json() as Promise<{ nickname: string | null }>;
const RENAME = (nickname: string) =>
  PUT_AUTHOR(new Request(`${ORIGIN}/api/templates/cloud/author`, { method: "PUT", body: JSON.stringify({ nickname }), headers: { "content-type": "application/json", host: "127.0.0.1:3461", origin: ORIGIN, "sec-fetch-site": "same-origin" } }));

let home = "";
let defaultNickname = "";

/** The raw `nickname` field of a settings row's identity: production's, whatever mode wrote the row. */
function storedField(row: number): string | null {
  const raw = getDb().select({ v: settings.templatesAuthor }).from(settings).where(eq(settings.id, row)).get()?.v;
  return raw ? ((JSON.parse(raw) as { nickname?: string | null }).nickname ?? null) : null;
}

async function prepareHere(): Promise<{ nickname: string | null }> {
  fs.writeFileSync(path.join(home, "source.mp4"), "x");
  const t = await createTemplate({
    name: "Hook + caption",
    description: "Three seconds.",
    tags: ["hook", "caption"],
    scaffold: makeScaffold({ name: "Hook + caption", description: "Three seconds.", tags: ["hook", "caption"] }) as never,
    instructions: "# Purpose\nA hook.\n",
    copies: [],
    writes: [],
  });
  const c: JobContext<never> = {
    jobId: "prepare-1",
    params: templatePublishPrepareRunner.paramsSchema.parse({ templateId: t.id, exampleVideo: { path: path.join(home, "source.mp4") }, source: catalogSource() }) as never,
    resumeState: null,
    reportProgress: () => undefined,
    checkpoint: async () => undefined,
    shouldCancel: () => false,
  };
  return templatePublishPrepareRunner.run(c);
}

beforeEach(() => {
  vi.stubEnv("LIBI_TEST_MODE", undefined);
  vi.stubEnv("NEXT_PUBLIC_LIBI_SITE_URL", undefined);
  vi.stubEnv("LIBI_RUNTIME_SOURCE", undefined);
  __resetDevBuildForTests();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-nick-catalog-"));
  vi.stubEnv("LIBI_HOME", home);
  createTestDb();
  defaultNickname = getOrCreateTemplatesAuthor().nickname!;
  vi.mocked(setNickname).mockImplementation(async (_k, nickname) => ({ ok: true, nickname }));
});
afterEach(() => {
  resetTestDb();
  vi.unstubAllEnvs();
  __resetDevBuildForTests();
  vi.clearAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the nickname is kept per catalog", () => {
  it("learned from Development: shown on Development only; Production keeps its own, and a prepare there goes out under it", async () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "Dev Nick", templates: [] });
    expect(await (await MINE()).json()).toMatchObject({ nickname: "Dev Nick" });
    expect((await AUTHOR()).nickname).toBe("Dev Nick");
    expect(getTemplatesAuthorForDisplay(DEV)?.nickname).toBe("Dev Nick");

    setTemplatesCatalogSetting({ choice: "production", devOrigin: DEV, bypassToken: null });
    expect(catalogSource()).toBe(PROD);
    expect(getTemplatesAuthorForDisplay()?.nickname).toBe(defaultNickname);
    expect(getTemplatesAuthorForDisplay(PROD)?.nickname).toBe(defaultNickname);
    expect((await AUTHOR()).nickname).toBe(defaultNickname);
    expect((await prepareHere()).nickname).toBe(defaultNickname);
  });

  it("/mine writes back into the ACTIVE catalog's slot only", async () => {
    setTemplatesCatalogSetting({ choice: "production", devOrigin: DEV, bypassToken: null });
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "Prod Name", templates: [] });
    expect(await (await MINE()).json()).toMatchObject({ nickname: "Prod Name" });
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "Dev Nick", templates: [] });
    expect(await (await MINE()).json()).toMatchObject({ nickname: "Dev Nick" });
    expect(getTemplatesAuthor()?.nickname).toBe("Prod Name");
    expect(getTemplatesAuthor(PROD)?.nickname).toBe("Prod Name");
    expect(getTemplatesAuthor(DEV)?.nickname).toBe("Dev Nick");
  });

  it("a catalog with no nickname of its own falls back to Production's (the default), never another development catalog's", async () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    expect((await AUTHOR()).nickname).toBe(defaultNickname);
    expect((await prepareHere()).nickname).toBe(defaultNickname);
    expect(getTemplatesAuthor("https://other-dev.vercel.app")?.nickname).toBe(defaultNickname);
  });

  it("a rename on Development renames Development only", async () => {
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    expect((await RENAME("Tester")).status).toBe(200);
    expect(getTemplatesAuthor(DEV)?.nickname).toBe("Tester");
    expect(getTemplatesAuthor(PROD)?.nickname).toBe(defaultNickname);
    setTemplatesCatalogSetting({ choice: "production", devOrigin: DEV, bypassToken: null });
    expect((await AUTHOR()).nickname).toBe(defaultNickname);
  });

  it("the compare-and-set holds per slot: a write expecting Development's old value never lands over a newer one", () => {
    const { key } = getTemplatesAuthor()!;
    expect(setTemplatesAuthorNickname(key, "One", { source: DEV })).toBe(true);
    expect(setTemplatesAuthorNickname(key, "Two", { source: DEV, expectedNickname: defaultNickname })).toBe(false);
    expect(setTemplatesAuthorNickname(key, "Two", { source: DEV, expectedNickname: "One" })).toBe(true);
    expect(getTemplatesAuthor(DEV)?.nickname).toBe("Two");
    expect(getTemplatesAuthor()?.nickname).toBe(defaultNickname);
  });

  // Review I1 (2026-09-27): test mode shares LIBI_HOME with a normal boot. Its nickname lives in ONE slot of
  // its own, "test-mode" — never the `nickname` field, which is production's in every row.
  it("test mode keeps one slot of its own, keyed \"test-mode\"; the production field is never written", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    const { key, nickname: fieldBefore } = getOrCreateTemplatesAuthor(PROD);
    expect(catalogSource()).toBe("test-mode");
    expect(setTemplatesAuthorNickname(key, "Fixture Nick", { source: "test-mode" })).toBe(true);
    expect(getTemplatesAuthor("test-mode")?.nickname).toBe("Fixture Nick");
    // Omitted in test mode: test mode's own slot.
    expect(getTemplatesAuthor()?.nickname).toBe("Fixture Nick");
    expect((await AUTHOR()).nickname).toBe("Fixture Nick");
    expect(getTemplatesAuthor(PROD)?.nickname).toBe(fieldBefore);
    expect(storedField(2)).toBe(fieldBefore);
  });

  it("a test-mode nickname never reaches production's nickname or a production publish", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    getOrCreateTemplatesAuthor();
    expect((await RENAME("Test Bot")).status).toBe(200);
    expect(vi.mocked(setNickname)).toHaveBeenLastCalledWith(expect.any(String), "Test Bot");
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    expect(catalogSource()).toBe(PROD);
    expect(getTemplatesAuthor()?.nickname).toBe(defaultNickname);
    expect(getTemplatesAuthorForDisplay(PROD)?.nickname).toBe(defaultNickname);
    expect((await AUTHOR()).nickname).toBe(defaultNickname);
    expect((await prepareHere()).nickname).toBe(defaultNickname);
    for (const row of [1, 2]) expect(storedField(row)).not.toBe("Test Bot");
  });
});

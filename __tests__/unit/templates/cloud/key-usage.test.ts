import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";

vi.mock("@/lib/templates/cloud/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/templates/cloud/client")>()), fetchMine: vi.fn() }));
import { fetchMine } from "@/lib/templates/cloud/client";
import { getDb } from "@/lib/db/client";
import { templatePublishRequests, templates } from "@/lib/db/schema/sqlite";
import { createTemplate } from "@/lib/templates/store";
import { catalogSource } from "@/lib/templates/cloud/catalog-source";
import { creatorKeyInUse, publishedHere } from "@/lib/templates/cloud/key-usage";
import { generateCreatorKey } from "@/lib/templates/cloud/identity";

let home = "";
let templateId = "";
const KEY = generateCreatorKey();

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-key-usage-"));
  process.env.LIBI_HOME = home;
  createTestDb();
  const t = await createTemplate({
    name: "Hook",
    description: "d",
    tags: ["hook"],
    scaffold: makeScaffold({ name: "Hook", description: "d", tags: ["hook"] }) as never,
    instructions: "# Purpose\nA hook.\n",
    copies: [],
    writes: [],
  });
  templateId = t.id;
});
afterEach(() => {
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("creator key usage", () => {
  it("a local template that was never published is no use of the key; the site decides", async () => {
    expect(publishedHere()).toBe(false);
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: null, templates: [] });
    expect(await creatorKeyInUse(KEY)).toBe(false);
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "n", templates: [{ id: "abcdefghijklmnopqrst" } as never] });
    expect(await creatorKeyInUse(KEY)).toBe(true);
    // Entries libi's schema dropped are still the key's templates: used, even with none readable.
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: null, templates: [], dropped: 1 });
    expect(await creatorKeyInUse(KEY)).toBe(true);
    // A nickname the site holds for the key was chosen under it (a rename, or a publish): used.
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: true, nickname: "Nadav", templates: [] });
    expect(await creatorKeyInUse(KEY)).toBe(true);
    // The site can't be asked: a doubt counts as used.
    vi.mocked(fetchMine).mockResolvedValueOnce({ ok: false, error: "offline" });
    expect(await creatorKeyInUse(KEY)).toBe(true);
  });

  it("a published template, or a pending publish, linked to THIS catalog is use — decided without the site", async () => {
    getDb().update(templates).set({ cloudId: "abcdefghijklmnopqrst" }).where(eq(templates.id, templateId)).run();
    expect(publishedHere()).toBe(true);
    expect(await creatorKeyInUse(KEY)).toBe(true);
    expect(fetchMine).not.toHaveBeenCalled();
    getDb().update(templates).set({ cloudId: null, publishPending: "{}" }).where(eq(templates.id, templateId)).run();
    expect(publishedHere()).toBe(true);
  });

  it("a link to another catalog (test mode's fixture vs production) is not use of this catalog's key", () => {
    getDb().update(templates).set({ cloudId: "abcdefghijklmnopqrst", cloudSource: "test-mode" }).where(eq(templates.id, templateId)).run();
    expect(publishedHere()).toBe(false);
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(catalogSource()).toBe("test-mode");
    expect(publishedHere()).toBe(true);
  });

  it("a publish request that is publishing right now is use; one awaiting review is not", () => {
    const now = new Date();
    const row = { id: randomUUID(), templateId, source: catalogSource(), exampleVideo: "{}", nickname: null, fingerprint: "f", confirmCode: "c", createdAt: now, updatedAt: now };
    getDb().insert(templatePublishRequests).values({ ...row, status: "awaiting" }).run();
    expect(publishedHere()).toBe(false);
    getDb().update(templatePublishRequests).set({ status: "publishing" }).run();
    expect(publishedHere()).toBe(true);
  });
});

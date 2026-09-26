import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: vi.fn() } }));
vi.mock("@/lib/templates/cloud/client", () => ({ mineShowsLive: vi.fn() }));
import { mineShowsLive } from "@/lib/templates/cloud/client";
import { getOrCreateTemplatesAuthor, importTemplatesAuthorKey } from "@/lib/db/settings";
import { generateCreatorKey } from "@/lib/templates/cloud/identity";
import { getDb } from "@/lib/db/client";
import { jobs, templates } from "@/lib/db/schema/sqlite";
import { navigationEmitter } from "@/lib/navigation-events";
import { eq } from "drizzle-orm";
import { getTemplate, publishWorkDir, type PublishPending } from "@/lib/templates/store";
import { DELETE, GET } from "@/app/api/templates/cloud/pending/route";

const CLOUD = "abcdefghijklmnopqrst";
const pending = (extra: Partial<PublishPending> = {}): PublishPending => ({
  cloudId: CLOUD,
  version: 1,
  expiresAt: Date.now() + 60_000,
  body: {},
  uploads: [],
  uploaded: [],
  fingerprint: "f",
  ...extra,
});
function seed(id: string, record: PublishPending | string | null, name = `Template ${id}`, cloudId: string | null = null) {
  getDb()
    .insert(templates)
    .values({ id, name, cloudId, publishPending: record === null ? null : typeof record === "string" ? record : JSON.stringify(record) })
    .run();
}
const UPLOAD = { name: "example.mp4", url: "https://bucket/x", headers: {} };
/** Every upload done: a commit may have been sent. */
const committed = (extra: Partial<PublishPending> = {}) => pending({ uploads: [UPLOAD], uploaded: ["example.mp4"], ...extra });
function seedJob(templateId: string, status: "queued" | "running" | "completed" | "failed" | "cancel-requested") {
  getDb()
    .insert(jobs)
    .values({ id: `job-${templateId}-${status}`, kind: "template_publish", status, paramsHash: `h-${templateId}-${status}`, paramsJson: JSON.stringify({ templateId, exampleVideo: { fileId: "f" } }) })
    .run();
}
const del = (body: unknown) => DELETE(new Request("http://x/api/templates/cloud/pending", { method: "DELETE", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pending-route-"));
  vi.stubEnv("LIBI_HOME", home);
  createTestDb();
});
afterEach(() => {
  resetTestDb();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("GET /api/templates/cloud/pending", () => {
  it("lists only templates with a pending publish, each with a state the page can word", async () => {
    seed("t-none", null);
    seed("t-unfinished", pending());
    seed("t-reserved", pending({ abandoned: true }));
    seed("t-attention", pending({ needsAttention: "the catalog answered it with another version" }));
    seed("t-unreadable", "{not json");
    seed("t-running", pending());
    seedJob("t-running", "running");
    seedJob("t-unfinished", "failed"); // a finished job is not a publish in flight
    const body = await (await GET()).json();
    const byId = Object.fromEntries(body.pending.map((p: { templateId: string }) => [p.templateId, p]));
    expect(Object.keys(byId).sort()).toEqual(["t-attention", "t-reserved", "t-running", "t-unfinished", "t-unreadable"]);
    expect(byId["t-unfinished"]).toEqual({ templateId: "t-unfinished", name: "Template t-unfinished", state: "unfinished", cloudId: CLOUD, version: 1, detail: null });
    expect(byId["t-reserved"].state).toBe("reserved");
    expect(byId["t-attention"]).toMatchObject({ state: "needs-attention", detail: "the catalog answered it with another version" });
    expect(byId["t-unreadable"]).toMatchObject({ state: "unreadable", cloudId: null });
    expect(byId["t-running"].state).toBe("publishing");
    // The record's signed URLs and body never leave the server.
    expect(JSON.stringify(body)).not.toContain("uploads");
  });
});

describe("DELETE /api/templates/cloud/pending", () => {
  it("clears the record and the publish work folder, and refreshes the Templates page", async () => {
    seed("t1", pending({ abandoned: true }));
    const work = publishWorkDir("t1");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "example.mp4"), "x");
    const r = await del({ templateId: "t1" });
    expect(r.status).toBe(200);
    expect(getTemplate("t1")?.publishPending).toBeNull();
    expect(fs.existsSync(work)).toBe(false);
    expect(navigationEmitter.emit).toHaveBeenCalledWith("refresh_query", { queryKey: "templates" });
  });

  it("discards an unreadable record too — libi won't guess at it, the creator decides", async () => {
    seed("t1", "{not json");
    expect((await del({ templateId: "t1" })).status).toBe(200);
    expect(getTemplate("t1")?.publishPending).toBeNull();
  });

  it("refuses while a publish of that template is queued, running or stopping: 409, record kept", async () => {
    for (const status of ["queued", "running", "cancel-requested"] as const) {
      resetTestDb();
      createTestDb();
      seed("t1", pending());
      seedJob("t1", status);
      const r = await del({ templateId: "t1" });
      expect(r.status, status).toBe(409);
      expect(getTemplate("t1")?.publishPending).not.toBeNull();
    }
  });

  it("404 when there is nothing pending; 400 without a template id", async () => {
    seed("t1", null);
    expect((await del({ templateId: "t1" })).status).toBe(404);
    expect((await del({ templateId: "nope" })).status).toBe(404);
    expect((await del({})).status).toBe(400);
    expect((await DELETE(new Request("http://x", { method: "DELETE", body: "{" }))).status).toBe(400);
  });
});

describe("DELETE /api/templates/cloud/pending — never a second public copy", () => {
  /** The current creator key's authorId: a record prepared under it. */
  let authorId: string;
  beforeEach(() => {
    authorId = getOrCreateTemplatesAuthor().authorId;
  });
  /** Every upload done, prepared under the current key: rule (c) may consult its list. */
  const mine = (extra: Partial<PublishPending> = {}) => committed({ authorId, ...extra });
  const kept = (id: string) => expect(getTemplate(id)?.publishPending).not.toBeNull();
  const gone = (id: string) => expect(getTemplate(id)?.publishPending).toBeNull();

  it("discards a reserved, a needs-attention and an unreadable record without asking the site", async () => {
    seed("t-res", committed({ abandoned: true }));
    seed("t-att", committed({ needsAttention: "the catalog answered it with another version" }));
    seed("t-bad", "{not json");
    for (const id of ["t-res", "t-att", "t-bad"]) {
      expect((await del({ templateId: id })).status, id).toBe(200);
      gone(id);
    }
    expect(mineShowsLive).not.toHaveBeenCalled();
  });

  it("(a) discards an unfinished record whose uploads never all finished — no commit was ever sent", async () => {
    seed("t1", pending({ uploads: [UPLOAD], uploaded: [] }));
    expect((await del({ templateId: "t1" })).status).toBe(200);
    gone("t1");
    expect(mineShowsLive).not.toHaveBeenCalled();
  });

  it("(b) discards an unfinished republish — the template keeps its catalog id, so the next publish can't make a second one", async () => {
    seed("t1", committed(), "T", "live-cloud-id-000000");
    expect((await del({ templateId: "t1" })).status).toBe(200);
    gone("t1");
    expect(mineShowsLive).not.toHaveBeenCalled();
  });

  it("(c) discards an unfinished first publish only once the creator's list, read, shows it isn't live", async () => {
    seed("t1", mine());
    vi.mocked(mineShowsLive).mockResolvedValueOnce({ ok: true, live: false });
    expect((await del({ templateId: "t1" })).status).toBe(200);
    gone("t1");
    expect(mineShowsLive).toHaveBeenCalledWith(expect.any(String), CLOUD, 1);
  });

  it("refuses an unfinished first publish that did go live: the next publish of it finishes it", async () => {
    seed("t1", mine());
    vi.mocked(mineShowsLive).mockResolvedValueOnce({ ok: true, live: true });
    const r = await del({ templateId: "t1" });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.code).toBe("live");
    expect(body.error).toMatch(/The next publish of this template finishes it/);
    kept("t1");
  });

  it("refuses when the list can't be read — fail closed", async () => {
    seed("t1", mine());
    vi.mocked(mineShowsLive).mockResolvedValueOnce({ ok: false, error: "offline" });
    const r = await del({ templateId: "t1" });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.code).toBe("cannot_check");
    expect(body.error).toMatch(/try again in a minute/i);
    kept("t1");
  });

  it("refuses while a commit that got no answer may still be running on the site, without asking the list", async () => {
    seed("t1", committed({ unansweredCommitAt: Date.now() - 30_000 }));
    const r = await del({ templateId: "t1" });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.code).toBe("still_publishing");
    expect(body.error).toMatch(/still publishing — try again in a minute/i);
    kept("t1");
    expect(mineShowsLive).not.toHaveBeenCalled();
  });

  it("refuses when there is no creator key to check with", async () => {
    resetTestDb();
    createTestDb();
    seed("t1", committed());
    const r = await del({ templateId: "t1" });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("cannot_check");
    kept("t1");
  });

  it("a publish that starts while the site answers wins: 409, the record kept", async () => {
    seed("t1", mine());
    vi.mocked(mineShowsLive).mockImplementationOnce(async () => {
      seedJob("t1", "queued");
      return { ok: true, live: false };
    });
    const r = await del({ templateId: "t1" });
    expect(r.status).toBe(409);
    kept("t1");
  });

  it("a record that changed while the site answered is never cleared: 409, the new record kept", async () => {
    seed("t1", mine());
    const next = JSON.stringify(mine({ version: 2 }));
    vi.mocked(mineShowsLive).mockImplementationOnce(async () => {
      getDb().update(templates).set({ publishPending: next }).where(eq(templates.id, "t1")).run();
      return { ok: true, live: false };
    });
    const r = await del({ templateId: "t1" });
    expect(r.status).toBe(409);
    expect(getTemplate("t1")?.publishPending).toBe(next);
  });

  it("(c) never judges a publish prepared under another creator key: this key's list can't see it — 409 cannot_check, the record kept", async () => {
    seed("t1", committed({ authorId: "some-other-author-id" }));
    const r = await del({ templateId: "t1" });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.code).toBe("cannot_check");
    expect(body.error).toMatch(/import the key it was published under/i);
    kept("t1");
    expect(mineShowsLive).not.toHaveBeenCalled();
  });

  it("(c) after a key import: the old key's unfinished first publish is refused even though the new key's list doesn't show it", async () => {
    seed("t1", mine());
    importTemplatesAuthorKey(generateCreatorKey());
    vi.mocked(mineShowsLive).mockResolvedValue({ ok: true, live: false });
    const r = await del({ templateId: "t1" });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("cannot_check");
    kept("t1");
    expect(mineShowsLive).not.toHaveBeenCalled();
  });

  it("(c) a record naming no creator key fails closed the same way", async () => {
    seed("t1", committed());
    vi.mocked(mineShowsLive).mockResolvedValue({ ok: true, live: false });
    const r = await del({ templateId: "t1" });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.code).toBe("cannot_check");
    expect(body.error).toMatch(/import the key it was published under/i);
    kept("t1");
    expect(mineShowsLive).not.toHaveBeenCalled();
  });

  it("(a) and (b) don't depend on the key: another key's record, or one naming none, is still discarded when no commit was sent or the template keeps its id", async () => {
    seed("t-a", pending({ uploads: [UPLOAD], uploaded: [], authorId: "some-other-author-id" }));
    seed("t-b", committed({ authorId: "some-other-author-id" }), "T", "live-cloud-id-000000");
    seed("t-none", pending({ uploads: [UPLOAD], uploaded: [] }));
    for (const id of ["t-a", "t-b", "t-none"]) {
      expect((await del({ templateId: id })).status, id).toBe(200);
      gone(id);
    }
    expect(mineShowsLive).not.toHaveBeenCalled();
  });
});

// Test mode and a normal boot share LIBI_HOME: a pending publish started
// against the other catalog is listed with a note, and never judged by (or
// sent to) this one.
describe("a pending publish from another catalog", () => {
  const link = (id: string, cloudSource: string | null) => getDb().update(templates).set({ cloudSource }).where(eq(templates.id, id)).run();

  it("is listed as another catalog's, with no cloud id of this one", async () => {
    seed("t-fixture", committed());
    link("t-fixture", "test-mode");
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    const body = await (await GET()).json();
    expect(body.pending).toEqual([
      { templateId: "t-fixture", name: "Template t-fixture", state: "other-catalog", cloudId: null, version: null, detail: expect.stringMatching(/test-mode catalog/) },
    ]);
  });

  it("a normal boot discards a test-mode record without asking any catalog — even one whose commit may have been sent", async () => {
    getOrCreateTemplatesAuthor();
    seed("t-fixture", committed({ unansweredCommitAt: Date.now() }));
    link("t-fixture", "test-mode");
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    const r = await del({ templateId: "t-fixture" });
    expect(r.status).toBe(200);
    expect(mineShowsLive).not.toHaveBeenCalled();
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(getTemplate("t-fixture")?.publishPending).toBeNull();
  });

  it("test mode never discards the real catalog's record: it can't ask the catalog that holds it", async () => {
    getOrCreateTemplatesAuthor();
    seed("t-real", pending({ abandoned: true }));
    link("t-real", "https://libi.nagellabs.com");
    vi.stubEnv("LIBI_TEST_MODE", "1");
    const r = await del({ templateId: "t-real" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "other_catalog" });
    expect(mineShowsLive).not.toHaveBeenCalled();
    vi.stubEnv("LIBI_TEST_MODE", undefined);
    expect(getTemplate("t-real")?.publishPending).not.toBeNull();
  });
});

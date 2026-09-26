// __tests__/unit/jobs/template-publish-runner.test.ts
//
// The template_publish job end to end against the real store, preflight and
// settings, with the network (the catalog client) and ffprobe (publish-media's
// read-back) replaced. The job publishes a REQUEST's own example and poster —
// staged here the way the prepare job leaves them (__tests__ for that job:
// template-publish-prepare-runner.test.ts).
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";

vi.mock("@/lib/templates/cloud/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/templates/cloud/client")>();
  return {
    // The site's answers as the client classifies them — the real code.
    isPublishBusy: real.isPublishBusy,
    isPublishingPaused: real.isPublishingPaused,
    isGlobalCap: real.isGlobalCap,
    isCreatorNotApproved: real.isCreatorNotApproved,
    nextUtcDay: real.nextUtcDay,
    definitiveRefusal: real.definitiveRefusal,
    refusalMessage: real.refusalMessage,
    COMMIT_TIMEOUT_MS: real.COMMIT_TIMEOUT_MS,
    publishPrepare: vi.fn(),
    uploadSigned: vi.fn(),
    publishCommit: vi.fn(),
    mineShowsLive: vi.fn(),
    setNickname: vi.fn(),
    // The store's public-scope search reads the catalog cache, which may refresh through this.
    fetchIndex: vi.fn(async () => ({ ok: false, error: "offline", reason: "unreachable" })),
  };
});
vi.mock("@/lib/templates/cloud/publish-media", () => ({
  readBackExample: vi.fn(async (file: string) => ({ path: file, bytes: fs.statSync(file).size, durationSec: 3, width: 720, height: 1280 })),
}));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
// The job never starts another (nothing is exported or transcoded here any more).
const jobManager = { enqueue: vi.fn(), runToCompletion: vi.fn(), cancel: vi.fn(async () => undefined) };
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => jobManager }));

import { mineShowsLive, type CloudFail, type PublishErrorCode, publishCommit, publishPrepare, setNickname, uploadSigned } from "@/lib/templates/cloud/client";
import { readBackExample } from "@/lib/templates/cloud/publish-media";
import { mediaDigest, publishRequestDir, readRequestMedia } from "@/lib/templates/cloud/publish-request-media";
import { trackServerEvent } from "@/lib/analytics/server";
import { getDb } from "@/lib/db/client";
import { templates } from "@/lib/db/schema/sqlite";
import { getOrCreateTemplatesAuthor, getTemplatesAuthor, importTemplatesAuthorKey, setTemplatesAuthorNickname } from "@/lib/db/settings";
import { __resetRunnerRegistryForTests, getJobKindToToolIdsMap, getRunner, registerBuiltinRunners } from "@/lib/jobs/runners/registry";
import { templatePublishRunner } from "@/lib/jobs/runners/template-publish";
import { CancelledError, type JobContext } from "@/lib/jobs/types";
import { serverLogger } from "@/lib/logger";
import { CREATOR_NOT_APPROVED_MESSAGE, CREATOR_STATUS_REFRESH_KEY } from "@/lib/templates/cloud/constants";
import { navigationEmitter } from "@/lib/navigation-events";
import { generateCreatorKey } from "@/lib/templates/cloud/identity";
import { PRODUCTION_SITE_URL } from "@/lib/site-url";
import { templateScaffoldSchema } from "@/lib/templates/scaffold";
import { pendingOwnCatalogChanges, resetCatalogRefreshForTests } from "@/lib/templates/cloud/catalog-cache";
import { COMMIT_TIMEOUT_MS } from "@/lib/templates/cloud/client";
import { COMMIT_MAY_RUN_MS } from "@/lib/templates/store";
import { contentFingerprint, readPublishContent } from "@/lib/templates/cloud/publish-content";
import { clearPublishPending, createTemplate, getPublishPending, getTemplate, publishWorkDir, setPublishPending, templateDir } from "@/lib/templates/store";

const CLOUD_ID = "abcdefghijklmnopqrst";
/** The site's answers (libi-site lib/templates/publish.ts): the words for people, the code for libi. */
const SITE = {
  busy: { ok: false as const, status: 409, error: "This template is being published right now. Wait for that to finish, then try again.", code: "busy" },
  nothing_pending: { ok: false as const, status: 409, error: "Nothing is waiting to be published under that template and version — run prepare again.", code: "nothing_pending" },
  expired: { ok: false as const, status: 410, error: "The time to finish this publish ran out — run prepare again.", code: "expired" },
  replay_mismatch: { ok: false as const, status: 409, error: "That version is already published, from a different body. Run prepare to publish a new version.", code: "replay_mismatch" },
  forbidden: { ok: false as const, status: 403, error: "That template belongs to another creator key.", code: "forbidden" },
  not_found: { ok: false as const, status: 404, error: "No template with that id. Leave templateId out to publish a new one.", code: "not_found" },
  nickname_required: { ok: false as const, status: 400, error: "Set a nickname first (PUT /api/templates/authors/me).", code: "nickname_required" },
  moderated: { ok: false as const, status: 403, error: "site words", code: "moderated" },
  publishing_paused: { ok: false as const, status: 503, error: "Publishing to the catalog is paused right now. Nothing was published — try again later.", code: "publishing_paused" },
  caps_global: { ok: false as const, status: 429, error: "The catalog has taken all the new templates it can today. Try again tomorrow (UTC).", code: "caps_global" },
  creator_not_approved: { ok: false as const, status: 403, error: "Publishing to the catalog is invite-only, and this creator key isn't approved yet. Apply from libi's Templates page.", code: "creator_not_approved" },
  caps_global_prepare: { ok: false as const, status: 429, error: "The catalog has taken all the publishes it can today. Try again tomorrow (UTC).", code: "caps_global" },
} satisfies Record<string, CloudFail & { status: number; code: PublishErrorCode }>;
/** The same answer without its code: the words alone never decide anything. */
const wordsOnly = (r: CloudFail): CloudFail => ({ ok: false, status: r.status, error: r.error });
let home = "";
let templateId = "";
/** The publish request the user confirmed: its folder holds the example and poster the job sends. */
let requestId = "";
/** What the prepare job left in the request's folder. */
const EXAMPLE = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(8)]);
const POSTER = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
/** A request folder, as the prepare job leaves one. */
function stageRequest(example: Buffer = EXAMPLE, poster: Buffer = POSTER): string {
  const id = randomUUID();
  fs.mkdirSync(publishRequestDir(id), { recursive: true });
  fs.writeFileSync(path.join(publishRequestDir(id), "example.mp4"), example);
  fs.writeFileSync(path.join(publishRequestDir(id), "poster.jpg"), poster);
  return id;
}

type Ctx = JobContext<never> & { progress: number[]; checkpoints: unknown[] };
function ctx(params: unknown, shouldCancel: () => boolean = () => false): Ctx {
  const progress: number[] = [];
  const checkpoints: unknown[] = [];
  return {
    jobId: "job-1",
    params: params as never,
    resumeState: null,
    reportProgress: (d: number) => progress.push(d),
    checkpoint: async (s: unknown) => void checkpoints.push(s),
    shouldCancel,
    progress,
    checkpoints,
  };
}
/**
 * Let `p` settle, running the commit-retry waits (setTimeout, faked in
 * beforeEach) as they come, while the job's real I/O gets its turns.
 */
async function settled<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(20_000);
  }
  return p;
}
/**
 * `params` as the confirm route hands them: with the fingerprint of the
 * template and the request's media as they are right now — what the user just
 * reviewed. A test that passes its own `reviewedFingerprint` overrides it; a
 * template that can't be read gets a stand-in (the job refuses it before it
 * compares).
 */
async function reviewed(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  let reviewedFingerprint = "0".repeat(64);
  try {
    const media = await readRequestMedia(params.requestId as string);
    reviewedFingerprint = contentFingerprint(await readPublishContent(params.templateId as string), mediaDigest(media!));
  } catch {
    // The run throws the same reason first.
  }
  return { reviewedFingerprint, ...params };
}
const run = (params: Record<string, unknown>, shouldCancel?: () => boolean) =>
  settled(reviewed({ templateId, requestId, ...params }).then((p) => templatePublishRunner.run(ctx(p, shouldCancel))));

function uploads(names: string[]) {
  return names.map((name) => ({
    name,
    url: `https://storage.googleapis.com/libi-dev-templates/tmp/${CLOUD_ID}/v1/${name}`,
    headers: { "Content-Type": "x", "x-goog-content-length-range": `0,${name.length}` },
  }));
}
const FOUR = ["template.json", "index.md", "poster.jpg", "example.mp4"];
/** What each signed upload was handed, by name. */
function uploaded(): Map<string, Buffer> {
  return new Map(vi.mocked(uploadSigned).mock.calls.map(([up, buf]) => [up.name, buf]));
}
function prepBody() {
  return vi.mocked(publishPrepare).mock.calls[0][1] as {
    templateId?: string;
    name: string;
    description: string;
    tags: string[];
    scaffold: Record<string, unknown>;
    instructions: string;
    files: Array<{ name: string; bytes: number; contentType: string; md5: string }>;
    example: unknown;
  };
}

async function makeTemplate(opts: { name?: string; description?: string; tags?: string[]; instructions?: string } = {}) {
  const name = opts.name ?? "Hook + caption";
  const description = opts.description ?? "Three seconds.";
  const tags = opts.tags ?? ["hook", "caption"];
  const row = await createTemplate({
    name,
    description,
    tags,
    scaffold: makeScaffold({ name, description, tags }) as never,
    instructions: opts.instructions ?? "# Purpose\nA hook.\n",
    copies: [],
    writes: [],
  });
  return row.id;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tpl-publish-"));
  process.env.LIBI_HOME = home;
  createTestDb();
  templateId = await makeTemplate();
  requestId = stageRequest();
  const author = getOrCreateTemplatesAuthor();
  setTemplatesAuthorNickname(author.key, "nadav");
  vi.mocked(publishPrepare).mockImplementation(async () => ({ ok: true, templateId: CLOUD_ID, version: 1, uploads: uploads(FOUR), expiresAt: Date.now() + 15 * 60_000 }));
  vi.mocked(uploadSigned).mockResolvedValue({ ok: true });
  vi.mocked(publishCommit).mockResolvedValue({ ok: true, templateId: CLOUD_ID, version: 1, indexed: true });
  vi.mocked(mineShowsLive).mockResolvedValue({ ok: true, live: false });
  vi.mocked(setNickname).mockImplementation(async (_k, nickname) => ({ ok: true, nickname }));
});
afterEach(() => {
  vi.useRealTimers();
  resetCatalogRefreshForTests();
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("template_publish runner — registration", () => {
  it("is registered, one at a time, tied to no tool call (the user's confirm starts it), with no transient params", () => {
    expect(templatePublishRunner.kind).toBe("template_publish");
    expect(templatePublishRunner.mcpToolId).toBeUndefined();
    expect(templatePublishRunner.maxConcurrent).toBe(1);
    // A double submit attaches to the run in flight instead of racing it over one pending publish.
    expect(templatePublishRunner.exclusiveResource).toBe(true);
    __resetRunnerRegistryForTests();
    registerBuiltinRunners();
    expect(getRunner("template_publish")).toBe(templatePublishRunner);
    expect(getJobKindToToolIdsMap().get("template_publish")).toBeUndefined();
    // Exactly the four inputs: nothing per-call (a toolCallId, a timestamp) to break dedupe.
    const fp = "a".repeat(64);
    const id = randomUUID();
    const parsed = templatePublishRunner.paramsSchema.parse({ templateId: "t", requestId: id, nickname: " nadav ", reviewedFingerprint: fp });
    expect(parsed).toEqual({ templateId: "t", requestId: id, nickname: "nadav", reviewedFingerprint: fp });
  });

  it("validates the request id and the nickname — it takes no example source: it re-derives nothing", () => {
    const id = randomUUID();
    const parse = (p: Record<string, unknown>) => templatePublishRunner.paramsSchema.safeParse({ reviewedFingerprint: "a".repeat(64), ...p }).success;
    expect(parse({ templateId: "t", requestId: id })).toBe(true);
    for (const requestId of [undefined, "", "../x", "nope", id.toUpperCase()]) expect(parse({ templateId: "t", requestId }), String(requestId)).toBe(false);
    expect(parse({ templateId: "t" })).toBe(false);
    for (const nickname of ["a", "x".repeat(33), "bad!", "tab\there"]) expect(parse({ templateId: "t", requestId: id, nickname }), nickname).toBe(false);
    // What the user reviewed is the job's own requirement: no fingerprint, no publish.
    for (const reviewedFingerprint of [undefined, "", "abc", "A".repeat(64), 1]) {
      expect(parse({ templateId: "t", requestId: id, reviewedFingerprint }), String(reviewedFingerprint)).toBe(false);
    }
  });
});

describe("template_publish runner — only what the user reviewed", () => {
  it("refuses a template changed since the review — its text, or the prepared example or poster — before anything leaves the machine", async () => {
    const before = await reviewed({ templateId, requestId });
    fs.writeFileSync(path.join(templateDir(templateId), "index.md"), "# Purpose\nSomething else entirely.\n");
    await expect(settled(templatePublishRunner.run(ctx(before)))).rejects.toThrow("This template changed since it was prepared — ask the agent to prepare it again.");
    // The request's example or poster swapped after the review is a change too.
    for (const name of ["example.mp4", "poster.jpg"]) {
      const fresh = await reviewed({ templateId, requestId });
      const file = path.join(publishRequestDir(requestId), name);
      const was = fs.readFileSync(file);
      fs.writeFileSync(file, Buffer.concat([was, Buffer.from("!")]));
      await expect(settled(templatePublishRunner.run(ctx(fresh))), name).rejects.toThrow(/changed since it was prepared/);
      fs.writeFileSync(file, was);
    }
    // Another request's media (the same template, prepared again) is not what was reviewed.
    const fresh = await reviewed({ templateId, requestId });
    const other = stageRequest(Buffer.concat([EXAMPLE, Buffer.from("other cut")]));
    await expect(settled(templatePublishRunner.run(ctx({ ...fresh, requestId: other })))).rejects.toThrow(/changed since it was prepared/);
    expect(publishPrepare).not.toHaveBeenCalled();
    expect(setNickname).not.toHaveBeenCalled();
    expect(readBackExample).not.toHaveBeenCalled();
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("refuses when the request's example or poster is gone, or is not a regular file", async () => {
    const fresh = await reviewed({ templateId, requestId });
    const poster = path.join(publishRequestDir(requestId), "poster.jpg");
    fs.rmSync(poster);
    await expect(settled(templatePublishRunner.run(ctx(fresh)))).rejects.toThrow(/example video prepared for this publish is gone/);
    fs.symlinkSync(path.join(home, "elsewhere.jpg"), poster);
    fs.writeFileSync(path.join(home, "elsewhere.jpg"), POSTER);
    await expect(settled(templatePublishRunner.run(ctx(fresh)))).rejects.toThrow(/example video prepared for this publish is gone/);
    expect(publishPrepare).not.toHaveBeenCalled();
  });
});

describe("template_publish runner — the publish", () => {
  it("sends the request's own example and poster, prepares, uploads every file with the pinned headers, commits, stores the cloudId, tracks the event", async () => {
    const c = ctx(await reviewed({ templateId, requestId }));
    const r = await templatePublishRunner.run(c);
    expect(r).toEqual({ cloudId: CLOUD_ID, version: 1, exampleBytes: 20 });

    const body = prepBody();
    expect(body.files.map((f) => f.name).sort()).toEqual(["example.mp4", "index.md", "poster.jpg", "template.json"]);
    expect(body.files.every((f) => /^[A-Za-z0-9+/]{22}==$/.test(f.md5))).toBe(true);
    expect(body.example).toEqual({ durationSec: 3, width: 720, height: 1280 });
    expect(body.templateId).toBeUndefined();
    // Exactly the bytes the user reviewed — nothing exported or transcoded here.
    expect(uploaded().get("example.mp4")).toEqual(EXAMPLE);
    expect(uploaded().get("poster.jpg")).toEqual(POSTER);
    expect(jobManager.enqueue).not.toHaveBeenCalled();

    // The signed upload goes out exactly as the site signed it.
    expect(vi.mocked(uploadSigned)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(uploadSigned).mock.calls[0][0]).toEqual(uploads(FOUR)[0]);
    // Every uploaded byte is what the manifest declared.
    for (const [name, buf] of uploaded()) {
      const f = body.files.find((x) => x.name === name)!;
      expect(buf.byteLength, name).toBe(f.bytes);
      expect(createHash("md5").update(buf).digest("base64"), name).toBe(f.md5);
    }

    const commitBody = vi.mocked(publishCommit).mock.calls[0][1];
    expect(commitBody).toEqual({ ...body, templateId: CLOUD_ID, version: 1 });

    const row = getTemplate(templateId)!;
    expect(row.cloudId).toBe(CLOUD_ID);
    expect(row.origin).toBe("local");
    expect(row.version).toBe(2); // bumped: the media the card shows changed
    expect(trackServerEvent).toHaveBeenCalledWith("template_published", { hasCode: false });
    expect(c.progress.at(-1)).toBe(100);
    expect(c.progress).toEqual([...c.progress].sort((a, b) => a - b));
    expect(c.checkpoints.length).toBeGreaterThanOrEqual(3);
    // The published example and poster become the local template's own.
    expect(fs.readFileSync(path.join(templateDir(templateId), "example.mp4"))).toEqual(uploaded().get("example.mp4"));
    expect(fs.readFileSync(path.join(templateDir(templateId), "poster.jpg"))).toEqual(uploaded().get("poster.jpg"));
    // A-F live check N1: the catalog copy predates this publish — it is noted, so the Public tab shows it now.
    expect(pendingOwnCatalogChanges()).toMatchObject([{ cloudId: CLOUD_ID, version: 1, kind: "published" }]);
  });

  // A-F live check: the first commit hit the 15 s client timeout against a local site; only the replay finished it.
  it("gives a commit the site's own 60 s bound plus a margin — under the commit lease and the job's watchdog", () => {
    expect(COMMIT_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(COMMIT_TIMEOUT_MS).toBeLessThan(COMMIT_MAY_RUN_MS);
    // One send, then the longest retry delay, before the next progress tick.
    expect(COMMIT_TIMEOUT_MS + 16_000).toBeLessThan(templatePublishRunner.noProgressTimeoutMs!);
  });

  it("uploads template.json as exactly JSON.stringify of the schema-parsed scaffold it sent, carrying the ROW's metadata", async () => {
    // A stale, hand-edited template.json: other metadata, and a key the schema strips.
    const file = path.join(templateDir(templateId), "template.json");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...onDisk, name: "Old name", description: "old", tags: ["old"], evil: "x\u202ey" }));
    getDb().update(templates).set({ name: "  Fresh hook ", description: "Now with captions. ", tags: JSON.stringify(["hook"]) }).run();

    await run({});
    const body = prepBody();
    expect([body.name, body.description, body.tags]).toEqual(["Fresh hook", "Now with captions.", ["hook"]]);
    expect(body.scaffold).toMatchObject({ name: "Fresh hook", description: "Now with captions.", tags: ["hook"] });
    expect(body.scaffold).not.toHaveProperty("evil");
    const bytes = uploaded().get("template.json")!;
    expect(bytes.toString("utf8")).toBe(JSON.stringify(body.scaffold));
    // What commit checks: the raw JSON already IS the schema's output.
    const raw = JSON.parse(bytes.toString("utf8"));
    expect(templateScaffoldSchema.parse(raw)).toEqual(raw);
  });

  it("uploads index.md byte-identical to the instructions it sent: LF only, no BOM", async () => {
    fs.writeFileSync(path.join(templateDir(templateId), "index.md"), "\ufeff# Purpose\r\nA hook.\rSecond line.\r\n");
    await run({});
    const { instructions } = prepBody();
    expect(instructions).toBe("# Purpose\nA hook.\nSecond line.\n");
    expect(uploaded().get("index.md")!.equals(Buffer.from(instructions, "utf8"))).toBe(true);
  });

  it("republishing sends the stored cloud id", async () => {
    getDb().update(templates).set({ cloudId: CLOUD_ID }).run();
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: true, templateId: CLOUD_ID, version: 2, uploads: uploads(FOUR).map((u) => ({ ...u, url: u.url.replace("/v1/", "/v2/") })), expiresAt: Date.now() + 15 * 60_000 });
    vi.mocked(publishCommit).mockResolvedValueOnce({ ok: true, templateId: CLOUD_ID, version: 2, indexed: true });
    const r = await run({});
    expect(prepBody().templateId).toBe(CLOUD_ID);
    expect(vi.mocked(publishCommit).mock.calls[0][1]).toMatchObject({ templateId: CLOUD_ID, version: 2 });
    expect(r.version).toBe(2);
  });

});

describe("template_publish runner — a link from another catalog (test mode and a normal boot share LIBI_HOME)", () => {
  /** An id the test-mode fixture minted: the real site has never heard of it. */
  const FIXTURE_ID = "zzzzzzzzzzzzzzzzzzz7";
  const REAL_ID = "rrrrrrrrrrrrrrrrrrr5";
  const raw = () => getDb().select().from(templates).where(eq(templates.id, templateId)).get()!;
  const link = (values: Partial<typeof templates.$inferInsert>) => getDb().update(templates).set(values).where(eq(templates.id, templateId)).run();
  const testMode = () => vi.stubEnv("LIBI_TEST_MODE", "1");
  const normalBoot = () => vi.stubEnv("LIBI_TEST_MODE", undefined);
  afterEach(() => vi.unstubAllEnvs());
  /** The real site: it knows no fixture id, so asking for one is a 404 `not_found`. */
  const realSite = () =>
    vi.mocked(publishPrepare).mockImplementation(async (_key, body) =>
      (body as { templateId?: string }).templateId === FIXTURE_ID
        ? SITE.not_found
        : { ok: true, templateId: CLOUD_ID, version: 1, uploads: uploads(FOUR), expiresAt: Date.now() + 15 * 60_000 },
    );

  it("a template published in test mode publishes afresh against the real site in a normal boot — never stuck on not_found", async () => {
    link({ cloudId: FIXTURE_ID, cloudSource: "test-mode" });
    normalBoot();
    realSite();
    const r = await run({});
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(prepBody().templateId).toBeUndefined();
    expect(r).toMatchObject({ cloudId: CLOUD_ID, version: 1 });
    expect(raw()).toMatchObject({ cloudId: CLOUD_ID, cloudSource: PRODUCTION_SITE_URL, publishPending: null, origin: "local" });
    // A second publish in the same boot is an update of the REAL template.
    vi.mocked(publishPrepare).mockClear();
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: true, templateId: CLOUD_ID, version: 2, uploads: uploads(FOUR), expiresAt: Date.now() + 15 * 60_000 });
    vi.mocked(publishCommit).mockResolvedValueOnce({ ok: true, templateId: CLOUD_ID, version: 2, indexed: true });
    await run({});
    expect(prepBody().templateId).toBe(CLOUD_ID);
  });

  it("a test-mode pending publish is not replayed against the real site: a normal boot publishes afresh", async () => {
    link({
      cloudSource: "test-mode",
      publishPending: JSON.stringify({
        cloudId: FIXTURE_ID, version: 1, expiresAt: Date.now() + 60_000, body: { templateId: FIXTURE_ID, version: 1 },
        uploads: uploads(FOUR), uploaded: FOUR, fingerprint: "f", unansweredCommitAt: Date.now(),
      }),
    });
    normalBoot();
    realSite();
    await run({});
    expect(prepBody().templateId).toBeUndefined();
    for (const [, body] of vi.mocked(publishCommit).mock.calls) expect((body as { templateId: string }).templateId).toBe(CLOUD_ID);
    expect(mineShowsLive).not.toHaveBeenCalled();
    expect(raw()).toMatchObject({ cloudId: CLOUD_ID, cloudSource: PRODUCTION_SITE_URL, publishPending: null });
  });

  it("a template published to the real catalog is never published from test mode: its link stays as it was", async () => {
    link({ cloudId: REAL_ID, cloudSource: PRODUCTION_SITE_URL });
    testMode();
    await expect(run({})).rejects.toThrow(/public catalog/);
    expect(publishPrepare).not.toHaveBeenCalled();
    expect(readBackExample).not.toHaveBeenCalled();
    expect(raw()).toMatchObject({ cloudId: REAL_ID, cloudSource: PRODUCTION_SITE_URL });
  });

  it("a row linked before the source was recorded counts as the real catalog's", async () => {
    link({ cloudId: REAL_ID, cloudSource: null });
    testMode();
    await expect(run({})).rejects.toThrow(/public catalog/);
    normalBoot();
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: true, templateId: REAL_ID, version: 2, uploads: uploads(FOUR), expiresAt: Date.now() + 15 * 60_000 });
    vi.mocked(publishCommit).mockResolvedValueOnce({ ok: true, templateId: REAL_ID, version: 2, indexed: true });
    await run({});
    expect(prepBody().templateId).toBe(REAL_ID);
  });

  it("in test mode, a test-mode link republishes as an update to the fixture, and is recorded as the fixture's", async () => {
    testMode();
    // Test mode has an identity of its own (final review Minor 1): name it for the fixture.
    setTemplatesAuthorNickname(getOrCreateTemplatesAuthor().key, "eval-bot");
    const first = await run({});
    expect(raw()).toMatchObject({ cloudId: first.cloudId, cloudSource: "test-mode" });
    vi.mocked(publishPrepare).mockClear();
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: true, templateId: CLOUD_ID, version: 2, uploads: uploads(FOUR), expiresAt: Date.now() + 15 * 60_000 });
    vi.mocked(publishCommit).mockResolvedValueOnce({ ok: true, templateId: CLOUD_ID, version: 2, indexed: true });
    await run({});
    expect(prepBody().templateId).toBe(CLOUD_ID);
  });
});

describe("template_publish runner — identity", () => {
  it("an identity with no nickname is given its default at publish — sent to the site only when the site says it has none", async () => {
    const { key } = getTemplatesAuthor()!;
    setTemplatesAuthorNickname(key, null);
    vi.mocked(publishPrepare).mockResolvedValueOnce(SITE.nickname_required);
    const done = await run({});
    expect(done.cloudId).toBe(CLOUD_ID);
    const stored = getTemplatesAuthor()!.nickname;
    expect(stored).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}$/);
    expect(setNickname).toHaveBeenCalledTimes(1);
    expect(setNickname).toHaveBeenCalledWith(key, stored);
    // Asked, answered, then prepared again.
    const [firstPrep, secondPrep] = vi.mocked(publishPrepare).mock.invocationCallOrder;
    expect(firstPrep).toBeLessThan(vi.mocked(setNickname).mock.invocationCallOrder[0]);
    expect(vi.mocked(setNickname).mock.invocationCallOrder[0]).toBeLessThan(secondPrep);
  });

  it("a nickname the site already shows for this key is never replaced by the stored one: nothing is sent unless the site asks", async () => {
    await run({});
    expect(setNickname).not.toHaveBeenCalled();
    expect(getTemplatesAuthor()?.nickname).toBe("nadav");
  });

  it("sets the nickname on the site first when given, then stores it", async () => {
    setTemplatesAuthorNickname(getTemplatesAuthor()!.key, null);
    await run({ nickname: "fresh" });
    expect(setNickname).toHaveBeenCalledWith(getTemplatesAuthor()!.key, "fresh");
    expect(getTemplatesAuthor()?.nickname).toBe("fresh");
    expect(vi.mocked(setNickname).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(publishPrepare).mock.invocationCallOrder[0]);
  });

  it("stops when the creator key is replaced while the nickname is being set — never writes it to the new identity", async () => {
    const replacement = generateCreatorKey();
    vi.mocked(setNickname).mockImplementationOnce(async (_k, nickname) => {
      importTemplatesAuthorKey(replacement);
      return { ok: true, nickname };
    });
    await expect(run({ nickname: "fresh" })).rejects.toThrow(/creator identity changed/);
    // The replacement keeps its own default nickname, never "fresh".
    expect(getTemplatesAuthor()).toMatchObject({ key: replacement, nickname: expect.stringMatching(/^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}$/) });
    // Caught at the nickname write itself: nothing is prepared under a key that is gone.
    expect(publishPrepare).not.toHaveBeenCalled();
  });

  // Final review Minor 3: a nickname renames every template this install published.
  it("sends the nickname only after the complete preflight — a publish the full preflight refuses renames nothing", async () => {
    vi.mocked(readBackExample).mockImplementationOnce(async (file: string) => ({ path: file, bytes: 20, durationSec: 40, width: 720, height: 1280 }));
    const err = await run({ nickname: "fresh" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^This template can't be published yet:/);
    expect(readBackExample).toHaveBeenCalled();
    expect(setNickname).not.toHaveBeenCalled();
    expect(getTemplatesAuthor()?.nickname).toBe("nadav");
    expect(publishPrepare).not.toHaveBeenCalled();
  });

  it("a stored nickname sent on the site's word stops when the key is replaced meanwhile — never written to the new identity", async () => {
    const replacement = generateCreatorKey();
    vi.mocked(publishPrepare).mockResolvedValueOnce(SITE.nickname_required);
    vi.mocked(setNickname).mockImplementationOnce(async (_k, nickname) => {
      importTemplatesAuthorKey(replacement);
      return { ok: true, nickname };
    });
    await expect(run({})).rejects.toThrow(/creator identity changed/);
    expect(getTemplatesAuthor()?.key).toBe(replacement);
    expect(getTemplatesAuthor()?.nickname).not.toBe("nadav");
    expect(publishPrepare).toHaveBeenCalledTimes(1);
  });

  /** The site's nickname for the key, as the catalog holds it: what every setNickname lands on. */
  function siteNickname() {
    const site = { nickname: null as string | null };
    vi.mocked(setNickname).mockImplementation(async (_k, nickname) => {
      site.nickname = nickname;
      return { ok: true, nickname };
    });
    return site;
  }
  /** The user's rename in "Publishing as": the site first, then this machine (app/api/templates/cloud/author). */
  function userRenames(site: { nickname: string | null }, key: string, name: string) {
    site.nickname = name;
    setTemplatesAuthorNickname(key, name);
  }

  it("the stored nickname is re-read right before it is sent: a rename made while prepare was asked goes out, not the old one", async () => {
    const { key } = getTemplatesAuthor()!;
    const site = siteNickname();
    vi.mocked(publishPrepare).mockImplementationOnce(async () => {
      userRenames(site, key, "Nadav");
      return SITE.nickname_required;
    });
    await run({});
    expect(setNickname).toHaveBeenCalledTimes(1);
    expect(setNickname).toHaveBeenCalledWith(key, "Nadav");
    expect(site.nickname).toBe("Nadav");
    expect(getTemplatesAuthor()?.nickname).toBe("Nadav");
  });

  it("a rename that lands WHILE the stored one is being sent wins on the SITE too: the user's name is sent again", async () => {
    const { key } = getTemplatesAuthor()!;
    const site = siteNickname();
    vi.mocked(publishPrepare).mockResolvedValueOnce(SITE.nickname_required);
    vi.mocked(setNickname).mockImplementationOnce(async (_k, nickname) => {
      userRenames(site, key, "typed-meanwhile"); // their PUT reached the site first…
      site.nickname = nickname; // …then this send landed over it
      return { ok: true, nickname };
    });
    const done = await run({});
    expect(done.cloudId).toBe(CLOUD_ID);
    expect(vi.mocked(setNickname).mock.calls.map(([, n]) => n)).toEqual(["nadav", "typed-meanwhile"]);
    expect(site.nickname).toBe("typed-meanwhile");
    expect(getTemplatesAuthor()?.nickname).toBe("typed-meanwhile");
  });

  it("losing to a rename twice stops the publish in plain words — nothing prepared again, and the site holds the user's latest", async () => {
    const { key } = getTemplatesAuthor()!;
    const site = siteNickname();
    vi.mocked(publishPrepare).mockResolvedValueOnce(SITE.nickname_required);
    let renames = 0;
    vi.mocked(setNickname).mockImplementation(async (_k, nickname) => {
      site.nickname = nickname;
      userRenames(site, key, `renamed ${++renames}`);
      return { ok: true, nickname };
    });
    await expect(run({})).rejects.toThrow(/nickname changed while this publish was sending it/);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(site.nickname).toBe(getTemplatesAuthor()?.nickname);
  });

  // Final review Minor 1: test mode shares LIBI_HOME but never touches the production identity.
  it("in test mode, the fixture's nickname and a freshly minted key stay in test mode's own identity", async () => {
    const production = getTemplatesAuthor()!;
    vi.stubEnv("LIBI_TEST_MODE", "1");
    try {
      expect(getTemplatesAuthor()).toBeNull();
      await run({ nickname: "eval-bot" });
      const testIdentity = getTemplatesAuthor()!;
      expect(testIdentity.nickname).toBe("eval-bot");
      expect(testIdentity.key).not.toBe(production.key);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(getTemplatesAuthor()).toEqual(production);
  });

  // Final review I1, through the real job: a failed identity write reaches the job's error without the key.
  it("a failed nickname write fails the job with libi's words, never the key", async () => {
    const key = getTemplatesAuthor()!.key;
    // Reads still work; every write now fails in the driver (SQLITE_READONLY).
    (getDb() as unknown as { $client: { pragma(s: string): unknown } }).$client.pragma("query_only = ON");
    try {
      const err = await run({ nickname: "fresh" }).catch((e: Error) => e);
      expect((err as Error).message).toBe("could not save the creator identity (SQLITE_READONLY)");
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(key);
      expect((err as Error).cause).toBeUndefined();
    } finally {
      (getDb() as unknown as { $client: { pragma(s: string): unknown } }).$client.pragma("query_only = OFF");
    }
  });

  it("stops when the creator key is replaced during the media step — never prepares under a key that is gone", async () => {
    vi.mocked(readBackExample).mockImplementationOnce(async (file: string) => {
      importTemplatesAuthorKey(generateCreatorKey());
      return { path: file, bytes: 20, durationSec: 3, width: 720, height: 1280 };
    });
    await expect(run({})).rejects.toThrow(/creator identity changed/);
    expect(publishPrepare).not.toHaveBeenCalled();
  });

  it("never logs the creator key", async () => {
    const spies = (["info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(serverLogger, m));
    await run({});
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: false, status: 403, error: "not yours" });
    await expect(run({})).rejects.toThrow(/not yours/);
    const key = getTemplatesAuthor()!.key;
    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(key);
  });
});

describe("template_publish runner — refusals", () => {
  it("fails before the nickname, the media or any upload when preflight finds a problem, listing every reason", async () => {
    const file = path.join(templateDir(templateId), "template.json");
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...s, assets: [{ ref: "clip", kind: "video", url: "https://127.0.0.1/x.mp4" }] }));
    getDb().update(templates).set({ name: "a" }).run();
    const err = await run({ nickname: "fresh" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^This template can't be published yet:\n- /);
    expect((err as Error).message).toMatch(/name needs at least 2 visible characters/);
    expect((err as Error).message).toMatch(/asset "clip" url must name a host, not an IP address/);
    expect(setNickname).not.toHaveBeenCalled();
    expect(readBackExample).not.toHaveBeenCalled();
    expect(publishPrepare).not.toHaveBeenCalled();
  });

  it("refuses a request body over the site's 256 KB cap before any media is made, though every file is under its own cap", async () => {
    const file = path.join(templateDir(templateId), "template.json");
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as { overlays: Array<Record<string, unknown>> };
    const params = Object.fromEntries(Array.from({ length: 470 }, (_, i) => [`p${i}`, "x".repeat(500)]));
    const overlays = [{ ...s.overlays[0], effects: { in: { effectId: "fade-in", params } } }];
    fs.writeFileSync(file, JSON.stringify({ ...s, overlays }));
    fs.writeFileSync(path.join(templateDir(templateId), "index.md"), `# Purpose\n${"y".repeat(30 * 1024)}`);
    const err = await run({}).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^This template can't be published yet:\n- Request body is too large\./);
    expect(readBackExample).not.toHaveBeenCalled();
    expect(publishPrepare).not.toHaveBeenCalled();
  });

  it("refuses a template installed from the catalog — it is someone else's", async () => {
    getDb().update(templates).set({ origin: "installed", cloudId: CLOUD_ID }).run();
    await expect(run({})).rejects.toThrow(/installed from the catalog/);
    expect(publishPrepare).not.toHaveBeenCalled();
  });

  it("passes the server's refusal through verbatim, and leaves the row unpublished", async () => {
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: false, status: 429, error: "You have published 20 times today — try again tomorrow." });
    await expect(run({})).rejects.toThrow(/20 times today/);
    expect(getTemplate(templateId)?.cloudId).toBeNull();
    expect(fs.existsSync(path.join(templateDir(templateId), "example.mp4"))).toBe(false);
  });

  it("the site asking for a nickname (code nickname_required) is sent the stored one once; asking again is answered with libi's own words, written for the review panel", async () => {
    vi.mocked(publishPrepare).mockResolvedValueOnce(SITE.nickname_required).mockResolvedValueOnce(SITE.nickname_required);
    await expect(run({})).rejects.toThrow('Set a nickname first — under "Publishing as" on the Templates page, or ask the agent to prepare the publish again with one.');
    expect(setNickname).toHaveBeenCalledTimes(1);
    expect(setNickname).toHaveBeenCalledWith(getTemplatesAuthor()!.key, "nadav");
    expect(uploadSigned).not.toHaveBeenCalled();
    // A site that refuses the stored nickname stops the publish, naming why.
    vi.mocked(publishPrepare).mockClear();
    vi.mocked(publishPrepare).mockResolvedValueOnce(SITE.nickname_required);
    vi.mocked(setNickname).mockResolvedValueOnce({ ok: false, status: 400, code: "invalid", error: "no" });
    await expect(run({})).rejects.toThrow(/could not set the nickname: no/);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
  });

  it("a refusal coded `moderated` says in libi's words that moderation hid it and the owner can't show it again", async () => {
    vi.mocked(publishPrepare).mockResolvedValueOnce(SITE.moderated);
    await expect(run({})).rejects.toThrow(/hidden by moderation.*can't show it again/);
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.moderated);
    await expect(run({})).rejects.toThrow(/hidden by moderation.*can't show it again/);
    expect(getTemplate(templateId)?.cloudId).toBeNull();
  });

  it("stops at a failed upload, naming the file, and never commits", async () => {
    vi.mocked(uploadSigned).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, status: 403, error: "upload of index.md answered 403" });
    await expect(run({})).rejects.toThrow(/index\.md/);
    expect(publishCommit).not.toHaveBeenCalled();
    expect(getTemplate(templateId)?.cloudId).toBeNull();
  });

  it("refuses to upload a file that changed after it was hashed", async () => {
    const png = path.join(templateDir(templateId), "assets", "logo.png");
    fs.mkdirSync(path.dirname(png), { recursive: true });
    fs.writeFileSync(png, Buffer.from([1, 2, 3]));
    const file = path.join(templateDir(templateId), "template.json");
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...s, assets: [...(s.assets as unknown[]), { ref: "logo", kind: "image", file: "assets/logo.png" }] }));
    vi.mocked(publishPrepare).mockImplementationOnce(async () => {
      fs.writeFileSync(png, Buffer.from([9, 9, 9]));
      return { ok: true, templateId: CLOUD_ID, version: 1, uploads: uploads([...FOUR, "assets/logo.png"]), expiresAt: Date.now() + 15 * 60_000 };
    });
    await expect(run({})).rejects.toThrow(/assets\/logo\.png changed/);
    expect(publishCommit).not.toHaveBeenCalled();
  });

  it("the site refusing a commit is passed through and the row stays unpublished — the publish is kept until a refusal PROVES it never landed", async () => {
    vi.mocked(publishCommit).mockResolvedValueOnce({ ok: false, status: 400, error: "template.json is not the scaffold that was validated at prepare", code: "invalid" as const });
    await expect(run({})).rejects.toThrow(/not the scaffold that was validated/);
    expect(getTemplate(templateId)?.cloudId).toBeNull();
    // A 400 is not a verdict on whether an earlier send landed: the record stays.
    expect(mineShowsLive).toHaveBeenCalledTimes(1);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, version: 1 });
    // The retry replays it; the site (which dropped its record on that refusal) says nothing is pending — now proof.
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.nothing_pending);
    await run({});
    expect(vi.mocked(publishPrepare).mock.calls.map(([, b]) => (b as { templateId?: string }).templateId ?? null)).toEqual([null, CLOUD_ID]);
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
  });

  it("cancels between steps: nothing prepared after a cancel during the media", async () => {
    let cancelled = false;
    vi.mocked(readBackExample).mockImplementationOnce(async (file: string) => {
      cancelled = true;
      return { path: file, bytes: 20, durationSec: 3, width: 720, height: 1280 };
    });
    await expect(run({}, () => cancelled)).rejects.toBeInstanceOf(CancelledError);
    expect(publishPrepare).not.toHaveBeenCalled();
  });

  it("the request's own folder is never touched: a retry sends the same files", async () => {
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: false, status: 429, error: "You have published 20 times today — try again tomorrow." });
    await expect(run({})).rejects.toThrow(/20 times/);
    expect(fs.readdirSync(publishRequestDir(requestId)).sort()).toEqual(["example.mp4", "poster.jpg"]);
    await run({});
    expect(uploaded().get("example.mp4")).toEqual(EXAMPLE);
  });
});

describe("template_publish runner — one cloud id, across timeouts and restarts", () => {
  const TIMEOUT = { ok: false as const, error: "The operation was aborted due to timeout" };
  const OK = { ok: true as const, templateId: CLOUD_ID, version: 1, indexed: true };
  const prepareIds = () => vi.mocked(publishPrepare).mock.calls.map(([, b]) => (b as { templateId?: string }).templateId ?? null);
  /** First attempt: every commit goes unanswered, so the job ends with the publish pending and every file uploaded. */
  async function commitNeverAnswered() {
    vi.mocked(publishCommit).mockResolvedValue(TIMEOUT);
    await expect(run({})).rejects.toThrow(/may already be published[\s\S]*try again/i);
    expect(publishCommit).toHaveBeenCalledTimes(5); // the first try and four retries
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, version: 1, uploaded: FOUR });
    vi.mocked(publishCommit).mockReset().mockResolvedValue(OK);
  }
  /** The last unanswered send was long ago: it cannot still be running on the site. */
  function ageUnansweredCommit() {
    setPublishPending(templateId, { ...getPublishPending(templateId)!, unansweredCommitAt: Date.now() - 10 * 60_000 });
  }
  /** First attempt: the connection drops on the first upload, so no commit was ever sent. */
  async function uploadDropped() {
    vi.mocked(uploadSigned).mockResolvedValueOnce({ ok: false, error: "socket hang up" });
    await expect(run({})).rejects.toThrow(/upload of template\.json failed/);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, uploaded: [] });
    vi.mocked(uploadSigned).mockClear();
  }

  it("records the cloud id, version and signed uploads on the row after prepare and BEFORE any upload, and clears them once published", async () => {
    let atFirstUpload: ReturnType<typeof getPublishPending> = null;
    vi.mocked(uploadSigned).mockImplementationOnce(async () => {
      atFirstUpload = getPublishPending(templateId);
      return { ok: true };
    });
    const c = ctx(await reviewed({ templateId, requestId }));
    await templatePublishRunner.run(c);
    expect(atFirstUpload).toMatchObject({ cloudId: CLOUD_ID, version: 1, uploaded: [], uploads: uploads(FOUR), authorId: getTemplatesAuthor()!.authorId });
    expect(atFirstUpload!.body).toEqual(vi.mocked(publishCommit).mock.calls[0][1]);
    expect(c.checkpoints).toContainEqual(expect.objectContaining({ step: "prepared", cloudId: CLOUD_ID, version: 1 }));
    expect(getPublishPending(templateId)).toBeNull();
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
  });

  it("a commit that timed out here but landed on the site: the retry replays it, gets the same success, and marks the row published — no second prepare", async () => {
    await commitNeverAnswered();
    expect(getTemplate(templateId)?.cloudId).toBeNull();

    const r = await run({});
    expect(r).toEqual({ cloudId: CLOUD_ID, version: 1, exampleBytes: 20 });
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(readBackExample).toHaveBeenCalledTimes(1);
    expect(uploadSigned).toHaveBeenCalledTimes(4);
    // The replay repeats the commit body exactly: the site answers a replay with the same success only for the same body.
    expect(vi.mocked(publishCommit).mock.calls[0][1]).toEqual({ ...prepBody(), templateId: CLOUD_ID, version: 1 });
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
    expect(getPublishPending(templateId)).toBeNull();
    expect(fs.readFileSync(path.join(templateDir(templateId), "example.mp4")).subarray(4, 12).toString()).toBe("ftypisom");
  });

  it("the site still finishing the same commit (409 busy) or failing a check (500): the commit is sent again after a wait, not given up", async () => {
    vi.mocked(publishCommit)
      .mockResolvedValueOnce(SITE.busy)
      .mockResolvedValueOnce({ ok: false, status: 500, error: "Could not check the uploaded files. Try publishing again." })
      .mockResolvedValueOnce(OK);
    expect((await run({})).cloudId).toBe(CLOUD_ID);
    expect(publishCommit).toHaveBeenCalledTimes(3);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
  });

  it("200 with indexed:false is still a publish: the id is recorded", async () => {
    vi.mocked(publishCommit).mockResolvedValueOnce({ ...OK, indexed: false });
    expect((await run({})).cloudId).toBe(CLOUD_ID);
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("a restart after prepare: the retry resumes the SAME signed uploads where they stopped, then commits — no new prepare, no new media", async () => {
    vi.mocked(uploadSigned).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: "socket hang up" });
    await expect(run({})).rejects.toThrow(/upload of index\.md failed/);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, uploaded: ["template.json"] });
    // The media a retry needs outlives the failed attempt.
    expect(fs.existsSync(path.join(publishWorkDir(templateId), "example.mp4"))).toBe(true);
    vi.mocked(uploadSigned).mockClear();

    const r = await run({});
    expect(r.cloudId).toBe(CLOUD_ID);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(readBackExample).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadSigned).mock.calls.map(([up]) => up)).toEqual(uploads(FOUR).slice(1));
    expect(vi.mocked(publishCommit).mock.calls[0][1]).toMatchObject({ templateId: CLOUD_ID, version: 1 });
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
    expect(getPublishPending(templateId)).toBeNull();
    expect(fs.existsSync(publishWorkDir(templateId))).toBe(false);
  });

  it("a pending first publish whose signed URLs expired, no commit ever sent: prepared again WITH its reserved id — the old record kept until the new one replaces it", async () => {
    await uploadDropped();
    setPublishPending(templateId, { ...getPublishPending(templateId)!, expiresAt: Date.now() - 1 });
    let pendingAtPrepare: ReturnType<typeof getPublishPending> | "unset" = "unset";
    vi.mocked(publishPrepare).mockImplementationOnce(async () => {
      pendingAtPrepare = getPublishPending(templateId);
      return { ok: true, templateId: CLOUD_ID, version: 1, uploads: uploads(FOUR), expiresAt: Date.now() + 15 * 60_000 };
    });

    await run({});
    // The site reserves a first publish's id for its author and answers a prepare of it with fresh URLs at v1.
    expect(prepareIds()).toEqual([null, CLOUD_ID]);
    // A crash between giving the old attempt up and the new prepare still knows the id.
    expect(pendingAtPrepare).toMatchObject({ cloudId: CLOUD_ID, version: 1, abandoned: true });
    expect(readBackExample).toHaveBeenCalledTimes(2);
    expect(uploadSigned).toHaveBeenCalledTimes(4);
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("a reserved id the site no longer holds (404 not_found — the reservation lapsed, nothing was ever live): a clean prepare, in the same run", async () => {
    await uploadDropped();
    setPublishPending(templateId, { ...getPublishPending(templateId)!, expiresAt: Date.now() - 1 });
    const FRESH = "bcdefghijklmnopqrstu";
    vi.mocked(publishPrepare)
      .mockResolvedValueOnce(SITE.not_found)
      .mockResolvedValueOnce({ ok: true, templateId: FRESH, version: 1, uploads: uploads(FOUR).map((u) => ({ ...u, url: u.url.replace(CLOUD_ID, FRESH) })), expiresAt: Date.now() + 15 * 60_000 });
    vi.mocked(publishCommit).mockResolvedValueOnce({ ok: true, templateId: FRESH, version: 1, indexed: true });
    expect((await run({})).cloudId).toBe(FRESH);
    expect(prepareIds()).toEqual([null, CLOUD_ID, null]);
    expect(getTemplate(templateId)?.cloudId).toBe(FRESH);
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("a reserved-id prepare that gets no answer: the id stays recorded, and the next attempt asks for it again", async () => {
    await uploadDropped();
    setPublishPending(templateId, { ...getPublishPending(templateId)!, expiresAt: Date.now() - 1 });
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: false, error: "The operation was aborted due to timeout" });
    await expect(run({})).rejects.toThrow(/timeout/);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, abandoned: true });
    await run({});
    expect(prepareIds()).toEqual([null, CLOUD_ID, CLOUD_ID]);
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
  });

  // Review A7 Minor 3: a record already abandoned is not abandoned again.
  it("a record already abandoned is not logged as newly abandoned on the next attempt", async () => {
    await uploadDropped();
    setPublishPending(templateId, { ...getPublishPending(templateId)!, expiresAt: Date.now() - 1 });
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: false, error: "The operation was aborted due to timeout" });
    const info = vi.spyOn(serverLogger, "info");
    await expect(run({})).rejects.toThrow(/timeout/);
    const abandonedLogs = () => info.mock.calls.filter(([o]) => (o as { op?: string }).op === "pending_abandoned").length;
    expect(abandonedLogs()).toBe(1);
    await run({});
    expect(abandonedLogs()).toBe(1);
  });

  // Review A7 Minor 6: a reservation held under another creator key (a key
  // import since) dead-ends every retry unless the error says the way out.
  it("a reserved-id prepare answered forbidden says how to get out: import that key, or discard the pending publish", async () => {
    await uploadDropped();
    setPublishPending(templateId, { ...getPublishPending(templateId)!, expiresAt: Date.now() - 1 });
    vi.mocked(publishPrepare).mockResolvedValueOnce(SITE.forbidden);
    await expect(run({})).rejects.toThrow(/belongs to another creator key\..*discard the pending publish/);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, abandoned: true, authorId: getTemplatesAuthor()!.authorId });
  });

  it("a pending REPUBLISH whose signed URLs expired: re-prepared under the same id", async () => {
    getDb().update(templates).set({ cloudId: CLOUD_ID }).run();
    await uploadDropped();
    setPublishPending(templateId, { ...getPublishPending(templateId)!, expiresAt: Date.now() - 1 });
    await run({});
    expect(prepareIds()).toEqual([CLOUD_ID, CLOUD_ID]);
  });

  it("a resumed upload the bucket refuses (its URL lapsed early): no commit was ever sent, so prepared again under its reserved id", async () => {
    await uploadDropped();
    vi.mocked(uploadSigned).mockResolvedValueOnce({ ok: false, status: 400, error: "upload of template.json answered 400" });
    await run({});
    expect(prepareIds()).toEqual([null, CLOUD_ID]);
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
  });

  it("a replay the site refuses (410 expired, or 409 nothing pending) that its list shows did NOT land: prepared again under its reserved id", async () => {
    for (const refusal of [SITE.expired, SITE.nothing_pending]) {
      await commitNeverAnswered();
      ageUnansweredCommit(); // the user comes back later: that send is long over
      vi.mocked(publishCommit).mockResolvedValueOnce(refusal);
      await run({});
      // The site keeps a first publish's id for its author: asking for it again can never make a second template.
      expect(prepareIds(), refusal.error).toEqual([null, CLOUD_ID]);
      expect(mineShowsLive).toHaveBeenCalledWith(expect.any(String), CLOUD_ID, 1);
      expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
      // Next round starts from an unpublished template again.
      getDb().update(templates).set({ cloudId: null }).run();
      vi.mocked(publishPrepare).mockClear();
      vi.mocked(publishCommit).mockClear();
      vi.mocked(mineShowsLive).mockClear();
    }
  });

  it("a replay the site refuses although it DID land (its receipt is gone): the creator's list says so, and the row is marked published — no prepare", async () => {
    await commitNeverAnswered();
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.nothing_pending);
    vi.mocked(mineShowsLive).mockResolvedValueOnce({ ok: true, live: true });
    expect((await run({})).cloudId).toBe(CLOUD_ID);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("a replay under another creator key (403 forbidden): surfaced, the pending publish kept, nothing prepared — this key's list cannot see that key's templates", async () => {
    await commitNeverAnswered();
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.forbidden);
    await expect(run({})).rejects.toThrow(/another creator key/);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(getPublishPending(templateId)?.cloudId).toBe(CLOUD_ID);
  });

  // Review A10 round 2: the discard route refuses a record prepared under
  // another key, so the replay's error must not send the creator there.
  it("the record names the creator key it was prepared under and keeps it through uploads, sends and a replay under a key imported since — whose error names only the import", async () => {
    const first = getTemplatesAuthor()!.authorId;
    await commitNeverAnswered();
    expect(getPublishPending(templateId)?.authorId).toBe(first);
    const other = importTemplatesAuthorKey(generateCreatorKey());
    setTemplatesAuthorNickname(other.key, "nadav");
    ageUnansweredCommit();
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.forbidden);
    const err = await run({}).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/started under another creator key: import that key again to finish it\.$/);
    expect(err?.message).not.toMatch(/discard/i);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, authorId: first });
    expect(publishPrepare).toHaveBeenCalledTimes(1);
  });

  it("the template changed since: the unanswered commit is replayed first; landed → the new content goes out as its next version, under the same id", async () => {
    await commitNeverAnswered();
    getDb().update(templates).set({ name: "Renamed hook" }).run();
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: true, templateId: CLOUD_ID, version: 2, uploads: uploads(FOUR).map((u) => ({ ...u, url: u.url.replace("/v1/", "/v2/") })), expiresAt: Date.now() + 15 * 60_000 });
    vi.mocked(publishCommit).mockResolvedValueOnce(OK).mockResolvedValueOnce({ ...OK, version: 2 });
    const r = await run({});
    expect(r.version).toBe(2);
    expect(prepareIds()).toEqual([null, CLOUD_ID]);
    expect(vi.mocked(publishCommit).mock.calls[0][1]).toMatchObject({ name: "Hook + caption", version: 1 });
    expect(vi.mocked(publishCommit).mock.calls[1][1]).toMatchObject({ name: "Renamed hook", templateId: CLOUD_ID, version: 2 });
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("the template changed since and the replay did not land: prepared again, with the new content, under its reserved id", async () => {
    await commitNeverAnswered();
    getDb().update(templates).set({ name: "Renamed hook" }).run();
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.expired);
    await run({});
    expect(prepareIds()).toEqual([null, CLOUD_ID]);
    expect(vi.mocked(publishPrepare).mock.calls[1][1]).toMatchObject({ name: "Renamed hook" });
  });

  it("a republish never takes a different id from the site", async () => {
    getDb().update(templates).set({ cloudId: CLOUD_ID }).run();
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: true, templateId: "bcdefghijklmnopqrstu", version: 2, uploads: uploads(FOUR), expiresAt: Date.now() + 60_000 });
    await expect(run({})).rejects.toThrow(/different template/);
    expect(getPublishPending(templateId)).toBeNull();
    expect(uploadSigned).not.toHaveBeenCalled();
  });

  // N1 (A6 re-review 1): the exact sequence that minted a duplicate.
  it("timeout → 429 → /mine empty: the record is KEPT (a 429 proves nothing), and the retry replays the same id", async () => {
    vi.mocked(publishCommit)
      .mockResolvedValueOnce(TIMEOUT) // commit #1: still running on the site
      .mockResolvedValueOnce({ ok: false, status: 429, error: "Too many requests. Slow down." }); // #2: a speed bump before the claim
    vi.mocked(mineShowsLive).mockResolvedValueOnce({ ok: true, live: false }); // #1 has not written its doc yet
    await expect(run({})).rejects.toThrow(/Too many requests/);
    expect(publishCommit).toHaveBeenCalledTimes(2);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, version: 1, uploaded: FOUR, unansweredCommitAt: expect.any(Number) });
    expect(getTemplate(templateId)?.cloudId).toBeNull();

    // Commit #1 lands; the retry replays it and gets the receipt — one id, one prepare.
    vi.mocked(publishCommit).mockReset().mockResolvedValue(OK);
    expect((await run({})).cloudId).toBe(CLOUD_ID);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("no refusal but a definitive one clears the record — a 429, a cap, a 400, an unknown code, another key: kept, with /mine empty", async () => {
    for (const refusal of [
      { ok: false as const, status: 429, error: "Too many requests." },
      { ok: false as const, status: 429, error: "You have published 20 times today — try again tomorrow.", code: "caps_daily" as const },
      { ok: false as const, status: 400, error: "poster.jpg is not a JPEG", code: "invalid" as const },
      SITE.forbidden,
      // The words without the status the site sends them under.
      { ok: false as const, status: 429, error: SITE.nothing_pending.error },
      // The site's exact words under its own status, but no code: the words never decide.
      wordsOnly(SITE.expired),
      wordsOnly(SITE.nothing_pending),
    ]) {
      vi.mocked(publishCommit).mockResolvedValueOnce(refusal);
      await expect(run({}), refusal.error).rejects.toThrow();
      expect(getPublishPending(templateId), JSON.stringify(refusal)).toMatchObject({ cloudId: CLOUD_ID, version: 1 });
      expect(publishCommit).toHaveBeenCalledTimes(1);
      clearPublishPending(templateId);
      vi.mocked(publishCommit).mockClear();
    }
  });

  it("publishing paused (503 publishing_paused) at commit: the site's words, sent once, the pending publish KEPT — and the replay once it resumes gets the receipt", async () => {
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.publishing_paused);
    const err = await run({}).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/^Publishing to the catalog is paused right now\. Nothing was published — try again later\. libi kept this publish/);
    // The site's own answer, not a missing one: not re-sent four times, not "may already be published".
    expect(err?.message).not.toMatch(/may already be published/);
    expect(publishCommit).toHaveBeenCalledTimes(1);
    // The request is over — the send is withdrawn — but the publish is not given up.
    const kept = getPublishPending(templateId);
    expect(kept).toMatchObject({ cloudId: CLOUD_ID, version: 1, uploaded: FOUR });
    expect(kept?.unansweredCommitAt).toBeUndefined();
    expect(kept?.abandoned).toBeUndefined();
    expect(getTemplate(templateId)?.cloudId).toBeNull();

    // Publishing resumes: the retry replays the SAME commit — no new prepare, no new media — and it lands.
    vi.mocked(publishCommit).mockReset().mockResolvedValue(OK);
    expect((await run({})).cloudId).toBe(CLOUD_ID);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(readBackExample).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishCommit).mock.calls[0][1]).toMatchObject({ templateId: CLOUD_ID, version: 1 });
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("not an approved creator (403 creator_not_approved) at prepare: libi's words, sent once, nothing recorded, nothing uploaded", async () => {
    const emit = vi.spyOn(navigationEmitter, "emit");
    vi.mocked(publishPrepare).mockReset().mockResolvedValue(SITE.creator_not_approved);
    const err = await run({}).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe(CREATOR_NOT_APPROVED_MESSAGE);
    expect(err?.message).not.toContain("Apply from libi's Templates page");
    // Review M2: the page's cached approval was wrong — it re-reads it (and only it).
    expect(emit).toHaveBeenCalledWith("refresh_query", { queryKey: CREATOR_STATUS_REFRESH_KEY });
    expect(emit).not.toHaveBeenCalledWith("refresh_query", { queryKey: "templates" });
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(uploadSigned).not.toHaveBeenCalled();
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("not an approved creator at commit: sent once, libi's words, and the pending publish KEPT for when they are approved", async () => {
    const emit = vi.spyOn(navigationEmitter, "emit");
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.creator_not_approved);
    const err = await run({}).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(CREATOR_NOT_APPROVED_MESSAGE);
    // Review M3: the site holds a prepared publish one hour, and approval is by hand — never an open-ended promise.
    expect(err?.message).toContain(
      "libi kept this publish, but the catalog holds it for only an hour after it was prepared: if you're approved within that hour, trying again finishes this same one, under the same id; after that, trying again starts the publish over.",
    );
    expect(err?.message).not.toContain("libi kept this publish: trying again finishes this same one");
    expect(emit).toHaveBeenCalledWith("refresh_query", { queryKey: CREATOR_STATUS_REFRESH_KEY });
    expect(err?.message).not.toMatch(/may already be published/);
    expect(publishCommit).toHaveBeenCalledTimes(1);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, version: 1, uploaded: FOUR });
    expect(getPublishPending(templateId)?.abandoned).toBeUndefined();
    // Approved later: the retry replays the same commit.
    vi.mocked(publishCommit).mockReset().mockResolvedValue(OK);
    expect((await run({})).cloudId).toBe(CLOUD_ID);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
  });

  it("not an approved creator at commit, approved only after the hour: the retry starts the publish over, as the words said", async () => {
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.creator_not_approved);
    await expect(run({})).rejects.toThrow(/only an hour/);
    // An hour on, the site has dropped the prepared publish: the replay is refused `expired`…
    setPublishPending(templateId, { ...getPublishPending(templateId)!, expiresAt: Date.now() - 1 });
    vi.mocked(publishCommit).mockReset().mockResolvedValueOnce(SITE.expired).mockResolvedValue(OK);
    // …and the attempt prepares and uploads it again (under its reserved id) — not "this same one".
    expect((await run({})).cloudId).toBe(CLOUD_ID);
    expect(prepareIds()).toEqual([null, CLOUD_ID]);
    expect(publishCommit).toHaveBeenCalledTimes(2);
  });

  it("publishing paused at prepare: the site's words, nothing recorded, nothing uploaded", async () => {
    vi.mocked(publishPrepare).mockReset().mockResolvedValue(SITE.publishing_paused);
    await expect(run({})).rejects.toThrow(/^Publishing to the catalog is paused right now\. Nothing was published — try again later\.$/);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(uploadSigned).not.toHaveBeenCalled();
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("the catalog-wide daily cap (429 caps_global) at commit: sent once, kept, and the creator is told not to retry before the next 00:00 UTC", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 24, 21, 30));
    vi.mocked(publishCommit).mockResolvedValue(SITE.caps_global);
    await expect(run({})).rejects.toThrow(
      "The catalog has taken all the new templates it can today. Try again tomorrow (UTC). libi kept this publish: trying again finishes this same one, under the same id. Don't try again before 2026-09-25T00:00:00Z (00:00 UTC) — until then the catalog refuses every attempt.",
    );
    // No automatic retry: one send, and nothing scheduled to send it again.
    expect(publishCommit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(publishCommit).toHaveBeenCalledTimes(1);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, version: 1, uploaded: FOUR });
    expect(getPublishPending(templateId)?.abandoned).toBeUndefined();
  });

  it("the catalog-wide daily cap at prepare: the site's words and the next 00:00 UTC; nothing recorded or uploaded", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 24, 3, 0));
    vi.mocked(publishPrepare).mockReset().mockResolvedValue(SITE.caps_global_prepare);
    await expect(run({})).rejects.toThrow(
      "The catalog has taken all the publishes it can today. Try again tomorrow (UTC). Don't try again before 2026-09-25T00:00:00Z (00:00 UTC) — until then the catalog refuses every attempt.",
    );
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(uploadSigned).not.toHaveBeenCalled();
    expect(getPublishPending(templateId)).toBeNull();
  });

  it("a 5xx or no answer on every send: kept, and the send is on the row before it goes out (a crash mid-commit counts)", async () => {
    let atSend: number | undefined;
    vi.mocked(publishCommit).mockImplementation(async () => {
      atSend ??= getPublishPending(templateId)?.unansweredCommitAt;
      return { ok: false, status: 502, error: "catalog answered 502" };
    });
    await expect(run({})).rejects.toThrow(/may already be published/);
    expect(atSend).toEqual(expect.any(Number));
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, unansweredCommitAt: expect.any(Number) });
  });

  it("'nothing pending' while an earlier send may still be running proves nothing: kept — in the same run, and on a quick retry; proof only once that send is over", async () => {
    const NOTHING = SITE.nothing_pending;
    vi.mocked(publishCommit).mockResolvedValueOnce(TIMEOUT).mockResolvedValueOnce(NOTHING);
    await expect(run({})).rejects.toThrow(/may already be published/);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID });

    vi.mocked(publishCommit).mockResolvedValueOnce(NOTHING);
    await expect(run({})).rejects.toThrow(/may already be published/);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID });
    expect(publishPrepare).toHaveBeenCalledTimes(1);

    ageUnansweredCommit();
    vi.mocked(publishCommit).mockResolvedValueOnce(NOTHING).mockResolvedValueOnce(OK);
    await run({});
    expect(prepareIds()).toEqual([null, CLOUD_ID]);
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
  });

  it("a definitive refusal by CODE, whatever the words: expired, wrong_version give the publish up once /mine agrees — its id kept for the next prepare", async () => {
    for (const refusal of [
      { ok: false as const, status: 410, error: "Reworded: too late.", code: "expired" as const },
      { ok: false as const, status: 409, error: "Reworded: not the next version.", code: "wrong_version" as const },
    ]) {
      vi.mocked(publishCommit).mockResolvedValueOnce(refusal);
      await expect(run({})).rejects.toThrow(refusal.error);
      expect(getPublishPending(templateId), refusal.code).toMatchObject({ cloudId: CLOUD_ID, version: 1, abandoned: true });
      // Given up: its media is not needed again.
      expect(fs.existsSync(publishWorkDir(templateId))).toBe(false);

      // The retry sends no commit for it again: it prepares under the same id.
      vi.mocked(publishCommit).mockClear();
      vi.mocked(publishPrepare).mockClear();
      expect((await run({})).cloudId).toBe(CLOUD_ID);
      expect(prepareIds(), refusal.code).toEqual([CLOUD_ID]);
      expect(vi.mocked(publishCommit).mock.calls.map(([, b]) => (b as { version: number }).version)).toEqual([1]);
      expect(getPublishPending(templateId)).toBeNull();
      getDb().update(templates).set({ cloudId: null }).run();
      vi.mocked(publishPrepare).mockClear();
    }
  });

  // A6 re-review 2, NEW-1: replay_mismatch means that version IS live — it can never justify a fresh id.
  it("replay_mismatch with /mine not showing it: the record is kept and marked 'needs attention', never given up or prepared afresh", async () => {
    await commitNeverAnswered();
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.replay_mismatch);
    await expect(run({})).rejects.toThrow(/needs attention[\s\S]*already published/);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, version: 1, needsAttention: expect.stringMatching(/already published/) });
    expect(getPublishPending(templateId)?.abandoned).toBeUndefined();
    expect(publishPrepare).toHaveBeenCalledTimes(1);

    // Not retried into the same answer.
    await expect(run({})).rejects.toThrow(/needs attention/);
    expect(publishCommit).toHaveBeenCalledTimes(1);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
  });

  it("replay_mismatch while /mine cannot be read: kept as it is — a later retry may see it live", async () => {
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.replay_mismatch);
    vi.mocked(mineShowsLive).mockResolvedValueOnce({ ok: false, error: "The operation was aborted due to timeout" });
    await expect(run({})).rejects.toThrow(/already published/);
    const kept = getPublishPending(templateId);
    expect(kept).toMatchObject({ cloudId: CLOUD_ID, version: 1 });
    expect(kept?.needsAttention).toBeUndefined();
    expect(kept?.abandoned).toBeUndefined();

    // The replay again; this time the list shows it live: published under that id.
    vi.mocked(publishCommit).mockResolvedValueOnce(SITE.replay_mismatch);
    vi.mocked(mineShowsLive).mockResolvedValueOnce({ ok: true, live: true });
    expect((await run({})).cloudId).toBe(CLOUD_ID);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(getTemplate(templateId)?.cloudId).toBe(CLOUD_ID);
  });

  it("a definitive refusal whose landing /mine cannot rule out (unreadable entries, no answer): kept", async () => {
    for (const mine of [
      { ok: false as const, status: 200, error: "1 of the creator's templates could not be read" },
      { ok: false as const, error: "The operation was aborted due to timeout" },
    ]) {
      vi.mocked(publishCommit).mockResolvedValueOnce(SITE.expired);
      vi.mocked(mineShowsLive).mockResolvedValueOnce(mine);
      await expect(run({})).rejects.toThrow(/could not check whether an earlier attempt landed/);
      expect(getPublishPending(templateId), mine.error).toMatchObject({ cloudId: CLOUD_ID });
      clearPublishPending(templateId);
    }
  });

  // N3: a site answering with another id or version is not retried into the same answer.
  it("a commit answered with another id or version: marked 'needs attention', not retried — on this run or any later one", async () => {
    vi.mocked(publishCommit).mockResolvedValueOnce({ ...OK, version: 2 });
    await expect(run({})).rejects.toThrow(/needs attention[\s\S]*Discard the pending publish/);
    expect(publishCommit).toHaveBeenCalledTimes(1);
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, version: 1, needsAttention: expect.stringMatching(/v2/) });
    expect(getTemplate(templateId)?.cloudId).toBeNull();

    await expect(run({})).rejects.toThrow(/needs attention/);
    expect(publishCommit).toHaveBeenCalledTimes(1);
    expect(publishPrepare).toHaveBeenCalledTimes(1);
    expect(readBackExample).toHaveBeenCalledTimes(1);
    expect(uploadSigned).toHaveBeenCalledTimes(4);
  });

  // M7: a cancel between uploads.
  it("a cancel during the upload loop: stops before the next upload, never commits, and keeps the publish for a retry to resume", async () => {
    let cancelled = false;
    vi.mocked(uploadSigned).mockImplementationOnce(async () => {
      cancelled = true; // the user presses Stop while template.json uploads
      return { ok: true };
    });
    await expect(run({}, () => cancelled)).rejects.toBeInstanceOf(CancelledError);
    expect(uploadSigned).toHaveBeenCalledTimes(1);
    expect(publishCommit).not.toHaveBeenCalled();
    expect(getPublishPending(templateId)).toMatchObject({ cloudId: CLOUD_ID, uploaded: ["template.json"] });
    expect(fs.existsSync(path.join(publishWorkDir(templateId), "example.mp4"))).toBe(true);

    vi.mocked(uploadSigned).mockClear();
    expect((await run({})).cloudId).toBe(CLOUD_ID);
    expect(vi.mocked(uploadSigned).mock.calls.map(([up]) => up.name)).toEqual(FOUR.slice(1));
    expect(publishPrepare).toHaveBeenCalledTimes(1);
  });

  it("removes its scratch media once nothing is pending: after a refusal before prepare, and after a publish", async () => {
    vi.mocked(publishPrepare).mockResolvedValueOnce({ ok: false, status: 429, error: "You have published 20 times today — try again tomorrow." });
    await expect(run({})).rejects.toThrow(/20 times/);
    expect(fs.existsSync(publishWorkDir(templateId))).toBe(false);
    await run({});
    expect(fs.existsSync(publishWorkDir(templateId))).toBe(false);
  });
});

describe("template_publish runner — a dev build switching catalogs", () => {
  const DEV = "http://localhost:3300";
  it("publishes to the catalog its request was prepared for, even after a switch to Production — and records the link there", async () => {
    const { setTemplatesCatalogSetting } = await import("@/lib/db/settings");
    const { catalogSource } = await import("@/lib/templates/cloud/catalog-source");
    const { __resetDevBuildForTests } = await import("@/lib/templates/cloud/catalog-setting");
    const { templatePublishRequests } = await import("@/lib/db/schema/sqlite");
    __resetDevBuildForTests();
    const now = new Date();
    getDb()
      .insert(templatePublishRequests)
      .values({ id: requestId, templateId, source: DEV, exampleVideo: "{}", fingerprint: "f", confirmCode: "c", status: "publishing", createdAt: now, updatedAt: now })
      .run();
    // The user switched to Production after confirming.
    setTemplatesCatalogSetting({ choice: "production", devOrigin: DEV, bypassToken: null });
    const seen: string[] = [];
    vi.mocked(publishPrepare).mockImplementation(async () => {
      seen.push(catalogSource());
      return { ok: true, templateId: CLOUD_ID, version: 1, uploads: uploads(FOUR), expiresAt: Date.now() + 15 * 60_000 };
    });
    vi.mocked(publishCommit).mockImplementation(async () => {
      seen.push(catalogSource());
      return { ok: true, templateId: CLOUD_ID, version: 1, indexed: true };
    });
    await settled(templatePublishRunner.run(ctx(await reviewed({ templateId, requestId }))));
    expect(seen).toEqual([DEV, DEV]);
    expect(getDb().select({ s: templates.cloudSource }).from(templates).where(eq(templates.id, templateId)).get()?.s).toBe(DEV);
    // Under Production the template is not linked here (its summary notes the other catalog) …
    expect(getTemplate(templateId)).toMatchObject({ cloudId: null });
    // … and the own-change watch is Development's, not Production's.
    expect(pendingOwnCatalogChanges()).toEqual([]);
    setTemplatesCatalogSetting({ choice: "development", devOrigin: DEV, bypassToken: null });
    expect(getTemplate(templateId)).toMatchObject({ cloudId: CLOUD_ID });
    expect(pendingOwnCatalogChanges()).toMatchObject([{ cloudId: CLOUD_ID, kind: "published" }]);
    void PRODUCTION_SITE_URL;
  });
});

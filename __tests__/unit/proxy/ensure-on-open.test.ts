/**
 * An evicted proxy is re-made when its piece is opened (lib/proxy/ensure.ts).
 *
 * The LRU drops a proxy through dropProxyFile(…, "lru"), which leaves the row
 * `idle`; nothing made it again. The dedupe trap: the eviction's own earlier
 * proxy_gen job is `completed`, so a plain enqueue answers
 * `matching_completed` and runs nothing. These tests run the REAL JobManager
 * on a test DB (only the proxy_gen runner's ffmpeg is replaced), and assert on
 * the jobs table: a new job must exist, not merely a call.
 *
 * Audio proxies are evictable too (review round 5, M4), and are re-made the
 * same way.
 *
 * Review fixes: only a proxy the LRU EVICTED is re-made, never one skipped on
 * purpose (I2: the onboarding clips); a re-make that wouldn't fit the budget
 * beside the piece's other proxies waits, so there is no evict → re-make loop
 * (I3); alpha is judged by the probed codec, not the extension (m6); the GET
 * answers before the pass even starts (m7).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v3";
import { and, eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { files, jobs } from "@/lib/db/schema/sqlite";
import { getDb } from "@/lib/db/client";
import { JobManager } from "@/lib/jobs/manager";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import { dropProxyFile } from "@/lib/proxy/lifecycle";
import { ensureProxiesForPiece, resetEnsureProxiesForTest } from "@/lib/proxy/ensure";
import { forgetEvictedProxies, listEvictedProxies } from "@/lib/proxy/evicted";
import { DEFAULT_PROXY_BYTE_BUDGET, evictProxiesIfOverBudget } from "@/lib/proxy/lru";
import { proxyLogger } from "@/lib/logger";
import { resetRegenOnceForTest } from "@/lib/proxy/regen-once";

const probe = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/ffmpeg/probe", () => ({
  // The video codec by name: "vpx-*" files are VP9, the rest ProRes.
  probeMedia: vi.fn(async (p: string) => {
    probe.calls.push(path.basename(p));
    return { videoCodec: path.basename(p).startsWith("vpx-") ? "vp9" : "prores" };
  }),
  probeMediaResult: vi.fn(async () => ({ ok: false, failure: "unreadable" })),
}));

/** What the fake proxy_gen writes: a proxy of this many bytes. */
const PROXY_BYTES = 60;

/** The proxy_gen runner, minus ffmpeg: marks the row ready once its gate opens. */
const gate = { open: Promise.resolve(), release: () => {} };
function holdJobs() {
  gate.open = new Promise<void>((r) => { gate.release = r; });
}
const runs: string[] = [];

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ensureProxiesForPiece", () => {
  let tmp: string;
  let mgr: JobManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ensure-"));
    vi.stubEnv("LIBI_HOME", tmp);
    vi.stubEnv("STORAGE_DIR", path.join(tmp, "storage"));
    const db = createTestDb();
    seedPiece(db, { id: "p1" });
    runs.length = 0;
    probe.calls = [];
    gate.open = Promise.resolve();
    __resetRunnerRegistryForTests();
    registerRunner({
      kind: "proxy_gen",
      maxConcurrent: 2,
      paramsSchema: z.object({ fileId: z.string().min(1) }),
      resumable: false,
      noProgressTimeoutMs: null,
      async run(ctx) {
        const { fileId } = ctx.params as { fileId: string };
        runs.push(fileId);
        await gate.open;
        const [row] = getDb().select().from(files).where(eq(files.id, fileId)).all();
        fs.writeFileSync(path.join(tmp, "storage", row.pieceId ?? "_global", `${fileId}-proxy.mp4`), Buffer.alloc(PROXY_BYTES));
        getDb().update(files).set({ proxyStatus: "ready", proxyFilename: `${fileId}-proxy.mp4`, proxyGeneratedAt: new Date() }).where(eq(files.id, fileId)).run();
        return { fileId };
      },
    });
    mgr = new JobManager();
    globalThis.__libiJobManager = mgr;
    resetRegenOnceForTest();
    resetEnsureProxiesForTest();
  });
  afterEach(async () => {
    gate.release();
    await new Promise((r) => setTimeout(r, 20));
    globalThis.__libiJobManager = undefined;
    __resetRunnerRegistryForTests();
    resetTestDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function file(id: string, over: Partial<typeof files.$inferInsert> = {}, pieceId: string | null = "p1") {
    const filename = over.filename ?? `${id}.mp4`;
    const dir = path.join(tmp, "storage", pieceId ?? "_global");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), "original");
    getDb().insert(files).values({ id, pieceId, filename, name: filename, description: "", type: "video", storagePath: `${pieceId ?? "_global"}/${filename}`, proxyStatus: "idle", ...over }).run();
  }
  const proxyJobs = (fileId: string) =>
    getDb().select().from(jobs).where(and(eq(jobs.kind, "proxy_gen"), eq(jobs.fileId, fileId))).all();

  /** A video whose proxy was made (a completed proxy_gen job), then evicted by the LRU. */
  async function evicted(id: string, pieceId: string | null = "p1", over: Partial<typeof files.$inferInsert> = {}) {
    file(id, over, pieceId);
    const first = await mgr.enqueue("proxy_gen", { fileId: id }, { pieceId: pieceId ?? undefined, fileId: id });
    if (first.status !== "new") throw new Error(`expected a new job, got ${first.status}`);
    await mgr.runToCompletion(first.jobId);
    dropProxyFile(id, "lru");
    expect(getDb().select().from(files).where(eq(files.id, id)).all()[0].proxyStatus).toBe("idle");
    return first.jobId;
  }

  it("the trap: a plain enqueue of an evicted proxy answers matching_completed and runs nothing", async () => {
    await evicted("f1");
    const again = await mgr.enqueue("proxy_gen", { fileId: "f1" }, { fileId: "f1" });
    expect(again.status).toBe("matching_completed");
  });

  it("an idle video whose proxy_gen job completed gets a NEW job, forced past the old one", async () => {
    const oldJob = await evicted("f1");
    runs.length = 0;
    expect(await ensureProxiesForPiece("p1")).toEqual(["f1"]);
    await until(() => runs.includes("f1") && proxyJobs("f1")[0]?.status === "completed");
    const rows = proxyJobs("f1");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(oldJob);
    expect(getDb().select().from(files).where(eq(files.id, "f1")).all()[0].proxyStatus).toBe("ready");
  });

  it("a library video the piece's composition uses is re-made too", async () => {
    await evicted("g1", null);
    fs.mkdirSync(path.join(tmp, "storage", "p1"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "storage", "p1", "composition.json"), JSON.stringify({ width: 1080, height: 1920, fps: 30, overlays: [{ id: "o1", kind: "video", fileId: "g1" }] }));
    runs.length = 0;
    expect(await ensureProxiesForPiece("p1")).toEqual(["g1"]);
    await until(() => runs.includes("g1"));
  });

  it("no job for an alpha (VPx) row, a failed row, an audio row, a generating row, or a missing original", async () => {
    file("alpha", { filename: "cut.webm", contentType: "video/webm", hasAlpha: true });
    file("failed", { proxyStatus: "failed" });
    file("audio", { filename: "voice.mp3", type: "audio" });
    file("gen", { proxyStatus: "generating" });
    file("gone");
    fs.rmSync(path.join(tmp, "storage", "p1", "gone.mp4"));
    expect(await ensureProxiesForPiece("p1")).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(getDb().select().from(jobs).all()).toHaveLength(0);
  });

  it("twice in a row (and while the first still runs): one job", async () => {
    await evicted("f1");
    holdJobs();
    runs.length = 0;
    const created: string[] = [];
    mgr.on("created", (e: { jobId: string }) => created.push(e.jobId));
    const [a, b] = await Promise.all([ensureProxiesForPiece("p1"), ensureProxiesForPiece("p1")]);
    expect(a).toEqual(["f1"]);
    expect(b).toEqual(["f1"]); // the same pass, shared
    await until(() => runs.length === 1);
    expect(await ensureProxiesForPiece("p1")).toEqual([]); // still running: left alone
    gate.release();
    await until(() => proxyJobs("f1")[0]?.status === "completed");
    expect(created).toHaveLength(1);
    expect(runs).toEqual(["f1"]);
  });

  it("a file re-made moments ago and evicted again is not re-made in a loop", async () => {
    await evicted("f1");
    await ensureProxiesForPiece("p1");
    await until(() => proxyJobs("f1")[0]?.status === "completed");
    dropProxyFile("f1", "lru"); // a budget too small for the piece
    runs.length = 0;
    expect(await ensureProxiesForPiece("p1")).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("starts at most a few per pass", async () => {
    for (let i = 0; i < 7; i++) await evicted(`f${i}`);
    holdJobs();
    const started = await ensureProxiesForPiece("p1");
    expect(started).toHaveLength(4);
  });

  it("an evicted audio proxy is re-made, without a probe; an audio file never evicted is not touched", async () => {
    await evicted("song", "p1", { type: "audio", filename: "song.m4a" });
    file("take", { type: "audio", filename: "take.wav" });
    runs.length = 0;
    expect(await ensureProxiesForPiece("p1")).toEqual(["song"]);
    await until(() => proxyJobs("song")[0]?.status === "completed");
    expect(probe.calls).toEqual([]);
    expect(proxyJobs("take")).toHaveLength(0);
  });

  describe("review I2: only an evicted proxy is re-made", () => {
    it("the onboarding clips (stored with skipProxyGeneration: idle, no job) get no proxy", async () => {
      file("clip-1");
      file("clip-2");
      expect(await ensureProxiesForPiece("p1")).toEqual([]);
      await new Promise((r) => setTimeout(r, 30));
      expect(getDb().select().from(jobs).all()).toHaveLength(0);
    });

    it("a proxy dropped for another reason (a user's drop) is not made again; its eviction record goes", async () => {
      await evicted("f1");
      expect(listEvictedProxies()).toHaveProperty("f1");
      getDb().update(files).set({ proxyStatus: "ready", proxyFilename: "f1-proxy.mp4" }).where(eq(files.id, "f1")).run();
      dropProxyFile("f1", "user");
      expect(listEvictedProxies()).not.toHaveProperty("f1");
      expect(await ensureProxiesForPiece("p1")).toEqual([]);
    });

    it("review n1: the eviction record stays while the re-make is queued, and goes when it completes", async () => {
      await evicted("f1");
      holdJobs();
      await ensureProxiesForPiece("p1");
      await until(() => runs.includes("f1"));
      expect(listEvictedProxies()).toHaveProperty("f1"); // running, not done
      gate.release();
      await until(() => proxyJobs("f1")[0]?.status === "completed");
      await until(() => !("f1" in listEvictedProxies()));
    });

    it("review n1: a quit while the re-make is queued keeps the record, and the next boot re-makes it", async () => {
      await evicted("f1");
      holdJobs();
      expect(await ensureProxiesForPiece("p1")).toEqual(["f1"]);
      await until(() => runs.includes("f1"));
      // Quit: the next boot's recoverOrphanedJobs fails the job; the row is still idle.
      getDb().update(jobs).set({ status: "failed" }).where(eq(jobs.fileId, "f1")).run();
      resetRegenOnceForTest();
      resetEnsureProxiesForTest();
      mgr = new JobManager();
      globalThis.__libiJobManager = mgr;
      expect(listEvictedProxies()).toHaveProperty("f1");
      expect(await ensureProxiesForPiece("p1")).toEqual(["f1"]);
    });
  });

  describe("review m6: alpha by codec", () => {
    it("an evicted VP9-alpha video in a .mov is never re-made (and its record goes); ProRes alpha is", async () => {
      await evicted("vpx", "p1", { filename: "vpx-cut.mov", hasAlpha: true });
      await evicted("prores", "p1", { filename: "prores-cut.mov", hasAlpha: true });
      runs.length = 0;
      expect(await ensureProxiesForPiece("p1")).toEqual(["prores"]);
      expect(listEvictedProxies()).not.toHaveProperty("vpx");
      expect(await ensureProxiesForPiece("p1")).toEqual([]); // not retried every open
    });
  });

  describe("review I3: no evict → re-make loop", () => {
    it("an evicted proxy that wouldn't fit beside the piece's other proxies stays pending, logged once", async () => {
      vi.stubEnv("LIBI_PROXY_BYTE_BUDGET", "100");
      await evicted("a"); // re-made below: 60 bytes on disk
      await ensureProxiesForPiece("p1");
      await until(() => proxyJobs("a")[0]?.status === "completed");
      await evicted("b");
      getDb().update(files).set({ proxyStatus: "idle", proxyFilename: null }).where(eq(files.id, "b")).run();
      // b's evicted proxy was 60 bytes (as a's): 60 + 60 > 100.
      const rec = listEvictedProxies();
      rec.b.bytes = 60;
      fs.writeFileSync(path.join(tmp, "state", "proxy-evicted.json"), JSON.stringify(rec));
      const warn = vi.spyOn(proxyLogger, "warn");
      runs.length = 0;
      for (let i = 0; i < 3; i++) expect(await ensureProxiesForPiece("p1")).toEqual([]);
      expect(runs).toEqual([]);
      const lines = warn.mock.calls.filter((c) => (c[0] as { op?: string }).op === "ensure_over_budget");
      expect(lines).toHaveLength(1);
      expect(lines[0][0]).toMatchObject({ tag: "proxy", pieceId: "p1", fileIds: ["b"], inUseBytes: 60, budget: 100 });
      expect(listEvictedProxies()).toHaveProperty("b"); // kept for when it fits
      warn.mockRestore();

      vi.stubEnv("LIBI_PROXY_BYTE_BUDGET", "1000");
      expect(await ensureProxiesForPiece("p1")).toEqual(["b"]);
    });

    it("review n4: an evicted AUDIO proxy is re-made even when it wouldn't fit (in-use audio is never evicted: no loop)", async () => {
      vi.stubEnv("LIBI_PROXY_BYTE_BUDGET", "100");
      await evicted("a");
      await ensureProxiesForPiece("p1");
      await until(() => proxyJobs("a")[0]?.status === "completed"); // 60 bytes of video, ready
      await evicted("song", "p1", { type: "audio", filename: "song.m4a" });
      const rec = listEvictedProxies();
      rec.song.bytes = 200;
      fs.writeFileSync(path.join(tmp, "state", "proxy-evicted.json"), JSON.stringify(rec));
      expect(await ensureProxiesForPiece("p1")).toEqual(["song"]);
    });

    it("a piece whose proxies exceed the budget: evictions and completions don't start a loop (one job, over many refreshes)", async () => {
      vi.stubEnv("LIBI_PROXY_BYTE_BUDGET", "100");
      await evicted("a");
      await evicted("b");
      for (const id of ["a", "b"]) {
        const rec = listEvictedProxies();
        rec[id].bytes = PROXY_BYTES;
        fs.writeFileSync(path.join(tmp, "state", "proxy-evicted.json"), JSON.stringify(rec));
      }
      const created: string[] = [];
      mgr.on("created", (e: { jobId: string }) => created.push(e.jobId));
      runs.length = 0;
      expect(await ensureProxiesForPiece("p1")).toEqual(["a"]); // 60 fits; b would make 120
      await until(() => proxyJobs("a")[0]?.status === "completed");
      for (let i = 0; i < 5; i++) {
        // What each completion / eviction refresh does: the LRU pass, then a GET's pass.
        evictProxiesIfOverBudget({ inUseFileIds: new Set(["a", "b"]) });
        expect(await ensureProxiesForPiece("p1")).toEqual([]);
      }
      expect(created).toHaveLength(1);
      expect(runs).toEqual(["a"]);
    });
  });

  describe("review FINAL I1: a large original 0.1.16 evicted is re-made after the backfill", () => {
    it("a 5 GB 4K original under the 4 GB budget: the backfill's record fits, so the open re-makes it", async () => {
      await evicted("big", "p1", { mediaDuration: 1200, mediaWidth: 3840, mediaHeight: 2160 });
      // 0.1.16: the LRU evicted it without a record, and the original is 5 GB (sparse).
      forgetEvictedProxies(["big"]);
      fs.truncateSync(path.join(tmp, "storage", "p1", "big.mp4"), 5 * 1024 * 1024 * 1024);
      const { sweepBackfillEvictedProxies } = await import("@/lib/proxy/backfill-evicted");
      expect(await sweepBackfillEvictedProxies()).toMatchObject({ recorded: 1 });
      expect(listEvictedProxies().big.bytes).toBeLessThan(DEFAULT_PROXY_BYTE_BUDGET);
      runs.length = 0;
      expect(await ensureProxiesForPiece("p1")).toEqual(["big"]);
      await until(() => proxyJobs("big")[0]?.status === "completed");
      expect(getDb().select().from(files).where(eq(files.id, "big")).all()[0].proxyStatus).toBe("ready");
    });
  });

  describe("GET /api/pieces/:id", () => {
    it("answers at once and re-makes the evicted proxy in the background", async () => {
      await evicted("f1");
      holdJobs();
      runs.length = 0;
      const { GET } = await import("@/app/api/pieces/[pieceId]/route");
      const res = await GET(new Request("http://127.0.0.1/api/pieces/p1"), { params: Promise.resolve({ pieceId: "p1" }) });
      expect(res.status).toBe(200); // not waiting on the held job
      expect((await res.json()).id).toBe("p1");
      await until(() => runs.includes("f1"));
    });

    it("the answer is sent before the pass starts (review m7)", async () => {
      const ensure = await import("@/lib/proxy/ensure");
      const spy = vi.spyOn(ensure, "ensureProxiesForPiece").mockResolvedValue([]);
      const { GET } = await import("@/app/api/pieces/[pieceId]/route");
      const res = await GET(new Request("http://127.0.0.1/api/pieces/p1"), { params: Promise.resolve({ pieceId: "p1" }) });
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      await new Promise((r) => setImmediate(r));
      expect(spy).toHaveBeenCalledWith("p1");
      spy.mockRestore();
    });

    // FINAL m-B2: the GET started a re-make for any caller. A stranger's page
    // still gets its answer (the /api/providers way) but starts no work.
    it("a cross-site request still gets the piece, and starts no re-make pass", async () => {
      const ensure = await import("@/lib/proxy/ensure");
      const spy = vi.spyOn(ensure, "ensureProxiesForPiece").mockResolvedValue([]);
      const { GET } = await import("@/app/api/pieces/[pieceId]/route");
      for (const site of ["cross-site", "same-site"]) {
        const res = await GET(
          new Request("http://127.0.0.1/api/pieces/p1", { headers: { "sec-fetch-site": site } }),
          { params: Promise.resolve({ pieceId: "p1" }) },
        );
        expect(res.status).toBe(200);
        expect((await res.json()).id).toBe("p1");
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("a failing re-make never fails the answer", async () => {
      const ensure = await import("@/lib/proxy/ensure");
      const spy = vi.spyOn(ensure, "ensureProxiesForPiece").mockImplementation(() => {
        throw new Error("boom");
      });
      const { GET } = await import("@/app/api/pieces/[pieceId]/route");
      const warn = vi.spyOn(proxyLogger, "warn");
      const res = await GET(new Request("http://127.0.0.1/api/pieces/p1"), { params: Promise.resolve({ pieceId: "p1" }) });
      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(warn.mock.calls.some((c) => (c[0] as { op?: string }).op === "ensure_on_open_failed")).toBe(true);
      warn.mockRestore();
      spy.mockRestore();
    });
  });
});

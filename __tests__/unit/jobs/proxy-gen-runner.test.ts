import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestDb, seedPiece } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/ffmpeg/exec", () => ({
  runFfmpeg: vi.fn(),
  resolveFfmpegPath: vi.fn(() => "/usr/bin/ffmpeg"),
  resolveFfprobePath: vi.fn(() => "/usr/bin/ffprobe"),
}));

import { getDb } from "@/lib/db/client";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { proxyGenRunner } from "@/lib/jobs/runners/proxy-gen";
import { JobManager } from "@/lib/jobs/manager";
import { jobIdOf } from "../../helpers/enqueue";

describe("proxyGenRunner", () => {
  let tmp: string;
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    registerRunner(proxyGenRunner);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-proxy-test-"));
    process.env.LIBI_HOME = tmp;
    // Ensure the jobs/ subdir exists for checkpoint writes (unused here, but defensive).
    fs.mkdirSync(path.join(tmp, "jobs"), { recursive: true });
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });
  afterEach(() => {
    delete process.env.LIBI_HOME;
    if (tmp && fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("happy path: runs ffmpeg, writes the proxy filename to the DB row", async () => {
    seedPiece(db, { id: "p", name: "p" });
    const pieceDir = path.join(tmp, "storage", "p");
    fs.mkdirSync(pieceDir, { recursive: true });
    const source = path.join(pieceDir, "video.mp4");
    fs.writeFileSync(source, Buffer.alloc(1024 * 1024)); // 1 MB
    db.insert(files)
      .values({
        id: "f1",
        pieceId: "p",
        filename: "video.mp4",
        name: "video",
        description: "",
        type: "video",
        storagePath: "p/video.mp4",
        contentType: "video/mp4",
        size: 1024 * 1024,
      })
      .run();

    vi.mocked(runFfmpeg).mockImplementation(async () => {
      // Simulate ffmpeg writing the proxy file.
      fs.writeFileSync(
        path.join(pieceDir, "video-proxy.mp4"),
        Buffer.alloc(200 * 1024),
      );
      return { stdout: "", stderr: "" };
    });

    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("proxy_gen", { fileId: "f1" }));
    const result = await mgr.runToCompletion<{
      fileId: string;
      proxyFilename: string;
      generatedAt: string;
    }>(jobId);
    expect(result.proxyFilename).toBe("video-proxy.mp4");
    expect(result.fileId).toBe("f1");

    const row = db
      .select()
      .from(files)
      .where(eq(files.id, "f1"))
      .all()[0];
    expect(row.proxyStatus).toBe("ready");
    expect(row.proxyFilename).toBe("video-proxy.mp4");
    expect(row.proxyGeneratedAt).toBeInstanceOf(Date);
  });

  it("missing source file throws", async () => {
    seedPiece(db, { id: "p", name: "p" });
    db.insert(files)
      .values({
        id: "f2",
        pieceId: "p",
        filename: "missing.mp4",
        name: "missing",
        description: "",
        type: "video",
        storagePath: "p/missing.mp4",
        contentType: "video/mp4",
        size: 1,
      })
      .run();

    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("proxy_gen", { fileId: "f2" }));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow(/source missing/);
  });

  it("uses canonical buildProxyArgs (not inlined drift)", async () => {
    seedPiece(db, { id: "p4", name: "p4" });
    const pieceDir = path.join(tmp, "storage", "p4");
    fs.mkdirSync(pieceDir, { recursive: true });
    fs.writeFileSync(path.join(pieceDir, "v.mp4"), Buffer.alloc(1024));
    db.insert(files)
      .values({
        id: "f4",
        pieceId: "p4",
        filename: "v.mp4",
        name: "v",
        description: "",
        type: "video",
        storagePath: "p4/v.mp4",
        contentType: "video/mp4",
        size: 1024,
      })
      .run();
    vi.mocked(runFfmpeg).mockImplementation(async () => {
      fs.writeFileSync(path.join(pieceDir, "v-proxy.mp4"), Buffer.alloc(256));
      return { stdout: "", stderr: "" };
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("proxy_gen", { fileId: "f4" }));
    await mgr.runToCompletion(jobId);

    const callArgs = vi.mocked(runFfmpeg).mock.calls[0][0] as string[];
    // Sanity checks that we're using the canonical buildProxyArgs output:
    // - libx264 ultrafast preset (NOT veryfast)
    // - crf 23 (NOT 26)
    // - pix_fmt yuv420p present
    // - sc_threshold 0 + keyint_min present
    expect(callArgs).toContain("ultrafast");
    expect(callArgs).toContain("23");
    expect(callArgs).toContain("yuv420p");
    expect(callArgs).toContain("0"); // sc_threshold value
    expect(callArgs.join(" ")).toContain("keyint_min");
  });

  it("writes proxy_status: 'generating' at start and 'ready' on success", async () => {
    seedPiece(db, { id: "p5", name: "p5" });
    const pieceDir = path.join(tmp, "storage", "p5");
    fs.mkdirSync(pieceDir, { recursive: true });
    fs.writeFileSync(path.join(pieceDir, "v.mp4"), Buffer.alloc(1024));
    db.insert(files)
      .values({
        id: "f5",
        pieceId: "p5",
        filename: "v.mp4",
        name: "v",
        description: "",
        storagePath: "p5/v.mp4",
        type: "video",
        contentType: "video/mp4",
        size: 1024,
      })
      .run();

    let observedStatusDuringRun: string | null = null;
    vi.mocked(runFfmpeg).mockImplementation(async () => {
      // Probe the DB mid-run to confirm "generating" was written.
      const mid = db.select().from(files).where(eq(files.id, "f5")).all()[0];
      observedStatusDuringRun = mid?.proxyStatus ?? null;
      fs.writeFileSync(path.join(pieceDir, "v-proxy.mp4"), Buffer.alloc(256));
      return { stdout: "", stderr: "" };
    });

    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("proxy_gen", { fileId: "f5" }));
    await mgr.runToCompletion(jobId);

    expect(observedStatusDuringRun).toBe("generating");
    const after = db.select().from(files).where(eq(files.id, "f5")).all()[0];
    expect(after.proxyStatus).toBe("ready");
  });

  it("sets proxy_status: 'failed' on ffmpeg error", async () => {
    seedPiece(db, { id: "p6", name: "p6" });
    const pieceDir = path.join(tmp, "storage", "p6");
    fs.mkdirSync(pieceDir, { recursive: true });
    fs.writeFileSync(path.join(pieceDir, "v.mp4"), Buffer.alloc(1024));
    db.insert(files)
      .values({
        id: "f6",
        pieceId: "p6",
        filename: "v.mp4",
        name: "v",
        description: "",
        storagePath: "p6/v.mp4",
        type: "video",
        contentType: "video/mp4",
        size: 1024,
      })
      .run();

    vi.mocked(runFfmpeg).mockRejectedValue(new Error("ffmpeg boom"));

    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("proxy_gen", { fileId: "f6" }));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow(/ffmpeg boom/);

    const row = db.select().from(files).where(eq(files.id, "f6")).all()[0];
    expect(row.proxyStatus).toBe("failed");
  });

  it("aborts the ffmpeg signal within ~1s of cancel (T23 cancel-cadence)", async () => {
    seedPiece(db, { id: "pc", name: "pc" });
    const pieceDir = path.join(tmp, "storage", "pc");
    fs.mkdirSync(pieceDir, { recursive: true });
    fs.writeFileSync(path.join(pieceDir, "v.mp4"), Buffer.alloc(1024));
    db.insert(files)
      .values({
        id: "fc",
        pieceId: "pc",
        filename: "v.mp4",
        name: "v",
        description: "",
        storagePath: "pc/v.mp4",
        type: "video",
        contentType: "video/mp4",
        size: 1024,
      })
      .run();

    // Track when the AbortSignal received the abort.
    let signal: AbortSignal | undefined;
    let abortAt: number | null = null;
    const ffmpegStarted: { resolve: () => void; promise: Promise<void> } = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { resolve, promise };
    })();
    const abortObserved: { resolve: () => void; promise: Promise<void> } = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { resolve, promise };
    })();

    vi.mocked(runFfmpeg).mockImplementation(async (_args, opts) => {
      signal = opts.signal;
      ffmpegStarted.resolve();
      // Simulate a long ffmpeg run — resolve either when the signal aborts
      // or after a max timeout (so failure mode is detectable).
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), 4500);
        if (signal) {
          signal.addEventListener("abort", () => {
            abortAt = Date.now();
            abortObserved.resolve();
            clearTimeout(t);
            reject(new Error("ffmpeg aborted"));
          });
        }
      });
      return { stdout: "", stderr: "" };
    });

    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("proxy_gen", { fileId: "fc" }));
    // Use runToCompletion but catch rejection — JobManager wins the race
    // and rejects with CancelledError. The runner's ffmpeg mock continues
    // running in the background until the watcher aborts it.
    const runPromise = mgr.runToCompletion(jobId).catch(() => undefined);

    // Wait for the runner to actually call runFfmpeg before cancelling.
    await ffmpegStarted.promise;
    const cancelAt = Date.now();
    await mgr.cancel(jobId);

    // Wait for the abort to be observed by the ffmpeg signal, with a
    // ceiling so the test still fails if the watcher never aborts.
    await Promise.race([
      abortObserved.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("watcher did not abort within 2000ms")), 2000),
      ),
    ]);

    expect(signal).toBeDefined();
    expect(abortAt).not.toBeNull();
    // Watcher polls at 1s; allow ~1.5s SLA.
    expect(abortAt! - cancelAt).toBeLessThan(1500);

    await runPromise;
  }, 10_000);

  it("refuses an alpha-bearing video BEFORE touching proxyStatus (chokepoint guard)", async () => {
    vi.mocked(runFfmpeg).mockClear(); // this file doesn't reset mocks between tests
    seedPiece(db, { id: "pa", name: "pa" });
    const pieceDir = path.join(tmp, "storage", "pa");
    fs.mkdirSync(pieceDir, { recursive: true });
    // Source EXISTS on disk — the refusal must fire on hasAlpha alone, not
    // fall through to a missing-source error.
    fs.writeFileSync(path.join(pieceDir, "cutout.webm"), Buffer.alloc(1024));
    db.insert(files)
      .values({
        id: "fa",
        pieceId: "pa",
        filename: "cutout.webm",
        name: "cutout",
        description: "",
        type: "video",
        storagePath: "pa/cutout.webm",
        contentType: "video/webm",
        size: 1024,
        hasAlpha: true,
      })
      .run();

    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("proxy_gen", { fileId: "fa" }));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow(/alpha/);

    // The guard sits BEFORE the proxyStatus:"generating" write, so the row
    // must stay idle (NOT "generating" and NOT "failed") — pickVideoUrl keeps
    // serving the original bytes and the UI never shows a phantom proxy state.
    const row = db.select().from(files).where(eq(files.id, "fa")).all()[0];
    expect(row.proxyStatus).toBe("idle");
    expect(row.proxyFilename).toBeNull();
    // ffmpeg must never have been invoked.
    expect(vi.mocked(runFfmpeg)).not.toHaveBeenCalled();
  });

  it("GENERATES a proxy for non-VPx alpha (ProRes-style .mov) — opaque proxy beats no preview", async () => {
    // Important 2 (pre-merge findings): the alpha refusal is scoped to formats
    // whose alpha is recoverable in preview (VPx). A ProRes-4444-style alpha
    // row must be able to (re)generate its scrub proxy — preview generally
    // can't decode the original at all, and exports read the ORIGINAL anyway.
    vi.mocked(runFfmpeg).mockClear();
    seedPiece(db, { id: "pp", name: "pp" });
    const pieceDir = path.join(tmp, "storage", "pp");
    fs.mkdirSync(pieceDir, { recursive: true });
    fs.writeFileSync(path.join(pieceDir, "graphics.mov"), Buffer.alloc(1024));
    db.insert(files)
      .values({
        id: "fp",
        pieceId: "pp",
        filename: "graphics.mov",
        name: "graphics",
        description: "",
        type: "video",
        storagePath: "pp/graphics.mov",
        contentType: "video/quicktime",
        size: 1024,
        hasAlpha: true,
      })
      .run();

    vi.mocked(runFfmpeg).mockImplementation(async () => {
      fs.writeFileSync(path.join(pieceDir, "graphics-proxy.mp4"), Buffer.alloc(128));
      return { stdout: "", stderr: "" };
    });

    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("proxy_gen", { fileId: "fp" }));
    const result = await mgr.runToCompletion<{ proxyFilename: string }>(jobId);
    expect(result.proxyFilename).toBe("graphics-proxy.mp4");

    const row = db.select().from(files).where(eq(files.id, "fp")).all()[0];
    expect(row.proxyStatus).toBe("ready");
    expect(row.proxyFilename).toBe("graphics-proxy.mp4");
    expect(vi.mocked(runFfmpeg)).toHaveBeenCalled();
  });

  it("non-video file throws", async () => {
    seedPiece(db, { id: "p", name: "p" });
    db.insert(files)
      .values({
        id: "f3",
        pieceId: "p",
        filename: "doc.pdf",
        name: "doc",
        description: "",
        type: "doc",
        storagePath: "p/doc.pdf",
        contentType: "application/pdf",
        size: 1,
      })
      .run();

    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("proxy_gen", { fileId: "f3" }));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow(/not a video/);
  });
});

/**
 * The one-time proxy sweeps' shared regeneration path (lib/proxy/regen-once.ts,
 * review round 3, R3-M3):
 * - the marker is written only once every regeneration has FINISHED: a quit
 *   while they are queued (proxy_gen runs two at a time; recoverOrphanedJobs
 *   fails whatever was left queued on the next boot) must not lose them;
 * - a sweep cut short resumes on the next boot and skips the files it did;
 * - one regeneration per file at a time: two sweeps asking for the same file
 *   share one job, and another caller's live proxy_gen job is waited for
 *   before a new one starts, so two writers never meet on one proxy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jobs = vi.hoisted(() => ({
  enqueue: vi.fn(),
  runToCompletion: vi.fn(),
}));
const repo = vi.hoisted(() => ({ findRunningByHash: vi.fn() }));
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => jobs }));
vi.mock("@/lib/jobs/repo", () => repo);
const db = vi.hoisted(() => ({ rows: [] as Array<{ id: string; pieceId: string | null; proxyStatus: string; proxyFilename: string | null; mediaHeight: number | null; proxyHeight: number | null }> }));
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          all: () => db.rows,
        }),
      }),
    }),
  }),
}));

import { regenerateProxy, runOnceSweep, sweepStaleGeneratingProxies, resetRegenOnceForTest } from "@/lib/proxy/regen-once";

/** A deferred: resolve it to finish a job. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("regen-once", () => {
  let tmp: string;
  let pending: Map<string, ReturnType<typeof deferred>>;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-regen-once-"));
    process.env.LIBI_HOME = tmp;
    pending = new Map();
    resetRegenOnceForTest();
    jobs.enqueue.mockReset().mockImplementation(async (_k: string, p: { fileId: string }) => ({ status: "new", jobId: `job-${p.fileId}` }));
    jobs.runToCompletion.mockReset().mockImplementation((jobId: string) => {
      const d = deferred();
      pending.set(jobId, d);
      return d.promise;
    });
    repo.findRunningByHash.mockReset().mockResolvedValue(null);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const marker = () => path.join(tmp, "state", "sweep-test-v1");
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("writes the marker only after every regeneration has finished", async () => {
    const sweep = runOnceSweep("sweep-test-v1", "sweep_test", async () => [{ id: "a", pieceId: "p" }, { id: "b", pieceId: "p" }]);
    await settle();
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(marker())).toBe(false); // queued, not finished
    pending.get("job-a")!.resolve();
    await settle();
    expect(fs.existsSync(marker())).toBe(false);
    pending.get("job-b")!.resolve();
    await sweep;
    expect(fs.existsSync(marker())).toBe(true);
  });

  it("a sweep cut short resumes on the next boot and skips what it finished", async () => {
    void runOnceSweep("sweep-test-v1", "sweep_test", async () => [{ id: "a", pieceId: "p" }, { id: "b", pieceId: "p" }]);
    await settle();
    pending.get("job-a")!.resolve(); // a finishes; the app quits with b still queued
    await settle();
    expect(fs.existsSync(marker())).toBe(false);
    // Next boot: a fresh process (fresh module state).
    jobs.enqueue.mockClear();
    vi.resetModules();
    const fresh = await import("@/lib/proxy/regen-once");
    const again = fresh.runOnceSweep("sweep-test-v1", "sweep_test", async () => [{ id: "a", pieceId: "p" }, { id: "b", pieceId: "p" }]);
    await settle();
    expect(jobs.enqueue.mock.calls.map((c) => c[1])).toEqual([{ fileId: "b" }]);
    pending.get("job-b")!.resolve();
    await again;
    expect(fs.existsSync(marker())).toBe(true);
    expect(fs.existsSync(`${marker()}.progress`)).toBe(false);
  });

  it("two sweeps asking for the same file share one regeneration", async () => {
    const one = runOnceSweep("sweep-one-v1", "sweep_one", async () => [{ id: "x", pieceId: "p" }]);
    const two = runOnceSweep("sweep-two-v1", "sweep_two", async () => [{ id: "x", pieceId: "p" }, { id: "y", pieceId: "p" }]);
    await settle();
    expect(jobs.enqueue.mock.calls.map((c) => c[1].fileId).sort()).toEqual(["x", "y"]);
    pending.get("job-x")!.resolve();
    pending.get("job-y")!.resolve();
    await Promise.all([one, two]);
    expect(fs.existsSync(path.join(tmp, "state", "sweep-one-v1"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "state", "sweep-two-v1"))).toBe(true);
  });

  it("waits for another caller's live proxy_gen job for the file before starting its own", async () => {
    repo.findRunningByHash.mockResolvedValue({ id: "job-live" });
    const done = regenerateProxy("z", "p");
    await settle();
    expect(jobs.runToCompletion).toHaveBeenCalledWith("job-live");
    expect(jobs.enqueue).not.toHaveBeenCalled(); // not while the other writer runs
    pending.get("job-live")!.resolve();
    await settle();
    expect(jobs.enqueue).toHaveBeenCalledWith("proxy_gen", { fileId: "z" }, { pieceId: "p", fileId: "z", forceNew: true });
    pending.get("job-z")!.resolve();
    expect(await done).toBe(true);
  });

  it("a regeneration that fails still counts as done: no retry every boot", async () => {
    jobs.runToCompletion.mockRejectedValue(new Error("ffmpeg refused"));
    await runOnceSweep("sweep-test-v1", "sweep_test", async () => [{ id: "bad", pieceId: "p" }]);
    expect(fs.readFileSync(marker(), "utf8")).toMatch(/regenerated=0 failed=1/);
  });

  it("every boot, a proxy a quit left at `generating` with no live job is regenerated (review round 4, M-b)", async () => {
    const { canonicalHash } = await import("@/lib/jobs/canonical-hash");
    const liveHash = canonicalHash({ fileId: "live" });
    repo.findRunningByHash.mockImplementation(async (_k: string, hash: string) => (hash === liveHash ? { id: "job-live" } : null));
    const { started, done } = await sweepStaleGeneratingProxies([
      { id: "stuck", pieceId: "p" },
      { id: "live", pieceId: "p" }, // a proxy_gen job for it is still queued or running: left alone
    ]);
    expect(started).toBe(1);
    expect(jobs.enqueue.mock.calls.map((c) => c[1])).toEqual([{ fileId: "stuck" }]);
    pending.get("job-stuck")!.resolve();
    await done;
  });

  it("a sweep run after the recovery (and a resumed one) doesn't repeat a file the recovery regenerated", async () => {
    await sweepStaleGeneratingProxies([{ id: "s1", pieceId: "p" }]);
    const sweep = runOnceSweep("sweep-test-v1", "sweep_test", async () => [{ id: "s1", pieceId: "p" }, { id: "s2", pieceId: "p" }]);
    await settle();
    expect(jobs.enqueue.mock.calls.map((c) => c[1].fileId)).toEqual(["s1", "s2"]); // s1 once, by the recovery
    pending.get("job-s1")!.resolve();
    pending.get("job-s2")!.resolve();
    await sweep;
  });

  it("the 720p sweep goes through the same per-file path: never two writers on one proxy (M-c)", async () => {
    db.rows = [{ id: "old720", pieceId: "p", proxyStatus: "ready", proxyFilename: "old720-proxy.mp4", mediaHeight: 1080, proxyHeight: null }];
    const { sweepRegenLegacy720pProxies } = await import("@/lib/proxy/regen-720p");
    const once = await import("@/lib/proxy/regen-once"); // the instance regen-720p uses
    once.resetRegenOnceForTest();
    sweepRegenLegacy720pProxies();
    // The MKV / late-start sweep asks for the same file while it is in flight: shared.
    const again = once.regenerateProxy("old720", "p");
    await settle();
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    pending.get("job-old720")!.resolve();
    expect(await again).toBe(true);
    db.rows = [];
  });
});

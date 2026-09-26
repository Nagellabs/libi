/**
 * `POST /api/social/upload` — the route that decides whether the export's
 * bytes go over the wire again.
 *
 * This is a data-loss test in the user's account, not a performance one.
 * The route used to enqueue with `forceNew: true`, so every pass through the
 * composer re-uploaded: three distinct `media.zernio.com/temp/…` objects for
 * ONE 1.3 MB export in eight minutes, and **Zernio exposes no delete-media
 * tool**, so each wasted upload is permanent litter the user cannot remove
 * (QA 2026-09-21, finding 5).
 *
 * The JobManager is faked here — keyed by the exact params the route builds,
 * which is what `(kind, paramsHash)` dedupe comes down to — so these tests
 * are about the ROUTE's decisions. The manager's own dedupe has its own
 * tests, and nothing here runs a real upload.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

// The export-folder gate is not what is under test, and it depends on the
// user's own settings. `exportFingerprint` is deliberately NOT mocked: the
// real stat of a real file is the thing being relied on.
vi.mock("@/lib/social/fit-check", () => ({ isAllowedExportPath: () => true }));

interface Enqueued {
  kind: string;
  params: Record<string, unknown>;
  forceNew: boolean;
}

const jobs = vi.hoisted(() => ({
  enqueues: [] as Array<{ kind: string; params: Record<string, unknown>; forceNew: boolean }>,
  /** paramsHash -> the terminal row the manager would answer with. */
  terminal: new Map<string, { jobId: string; status: string; result: unknown }>(),
  ran: [] as string[],
  nextId: 0,
}));

vi.mock("@/lib/jobs/manager", () => ({
  getJobManager: () => ({
    async enqueue(kind: string, params: Record<string, unknown>, options: { forceNew?: boolean } = {}) {
      const forceNew = options.forceNew === true;
      jobs.enqueues.push({ kind, params, forceNew });
      const hash = JSON.stringify(params);
      const hit = jobs.terminal.get(hash);
      if (hit && !forceNew) {
        return { status: "matching_completed", existingJob: { ...hit, pieceId: null, completedAt: "", error: null } };
      }
      const jobId = `job-${++jobs.nextId}`;
      // A forced run replaces the row for that hash, exactly as the real
      // manager's hard reset does.
      if (forceNew) jobs.terminal.delete(hash);
      return { status: "new", jobId, clientKey: "k", ...(forceNew ? { forced: true } : {}) };
    },
    async runToCompletion(jobId: string) {
      jobs.ran.push(jobId);
    },
  }),
}));

import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { setSocialSettings } from "@/lib/db/settings";
import { exportFingerprint } from "@/lib/social/export-fingerprint";
import { POST as uploadRoute } from "@/app/api/social/upload/route";

const EXPORT = path.join(os.tmpdir(), `libi-upload-route-${process.pid}.mp4`);

const UPLOAD = {
  publicUrl: "https://media.zernio.com/temp/1_e.mp4",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  sizeBytes: 1234,
  contentType: "video/mp4",
  filename: "e.mp4",
};

function post(body: unknown): Promise<Response> {
  return uploadRoute(new Request("http://x/api/social/upload", { method: "POST", body: JSON.stringify(body) }));
}

/** Mark the last enqueued params as a completed job with `result`, the way the
 *  job row would read after a successful upload. */
function completeLast(result: unknown = UPLOAD): void {
  const last = jobs.enqueues[jobs.enqueues.length - 1] as Enqueued;
  jobs.terminal.set(JSON.stringify(last.params), { jobId: `job-${jobs.nextId}`, status: "completed", result });
}

beforeEach(() => {
  createTestDb();
  setSocialSettings({ providerId: "zernio", timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
  fs.writeFileSync(EXPORT, "some bytes");
  jobs.enqueues.length = 0;
  jobs.ran.length = 0;
  jobs.terminal.clear();
  jobs.nextId = 0;
  for (const spy of Object.values(logSpies)) spy.mockClear();
});

afterEach(() => {
  resetTestDb();
  fs.rmSync(EXPORT, { force: true });
});

describe("POST /api/social/upload", () => {
  it("does not force a new job, and identifies the FILE (not just its path) in the params", async () => {
    const res = await post({ exportPath: EXPORT, pieceId: "p1" });
    expect(res.status).toBe(200);
    expect(jobs.enqueues).toHaveLength(1);
    expect(jobs.enqueues[0].forceNew).toBe(false);
    expect(jobs.enqueues[0].params).toEqual({
      providerId: "zernio",
      exportPath: EXPORT,
      pieceId: "p1",
      fileFingerprint: exportFingerprint(EXPORT),
    });
    expect(await res.json()).toEqual({ jobId: "job-1" });
  });

  it("reuses a completed upload for the same file instead of uploading it again", async () => {
    await post({ exportPath: EXPORT, pieceId: "p1" });
    completeLast();

    const res = await post({ exportPath: EXPORT, pieceId: "p1" });
    const body = await res.json();
    expect(body).toEqual({ jobId: "job-1", reused: true, result: UPLOAD });
    // No second upload was started — this is the whole point: every extra one
    // is a permanent object in the user's Zernio account.
    expect(jobs.enqueues.filter((e) => e.forceNew)).toHaveLength(0);
    // The first pass ran job-1 and that is all that ever ran.
    expect(jobs.ran).toEqual(["job-1"]);
  });

  it("uploads again when the export has actually changed underneath the same path", async () => {
    await post({ exportPath: EXPORT, pieceId: "p1" });
    completeLast();
    const first = exportFingerprint(EXPORT);

    // A re-export to the same path: same name, different bytes.
    fs.writeFileSync(EXPORT, "quite different bytes, a whole new render");
    fs.utimesSync(EXPORT, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(exportFingerprint(EXPORT)).not.toBe(first);

    const res = await post({ exportPath: EXPORT, pieceId: "p1" });
    const body = await res.json();
    expect(body.reused).toBeUndefined();
    expect(body.jobId).toBe("job-2");
    expect(jobs.ran).toEqual(["job-1", "job-2"]);
  });

  it("uploads again when the reusable URL is about to expire, because attaching happens later", async () => {
    await post({ exportPath: EXPORT, pieceId: "p1" });
    completeLast({ ...UPLOAD, expiresAt: new Date(Date.now() + 5_000).toISOString() });

    const res = await post({ exportPath: EXPORT, pieceId: "p1" });
    const body = await res.json();
    expect(body.reused).toBeUndefined();
    // The hash still matches, so only a FORCED enqueue can replace it.
    expect(jobs.enqueues[jobs.enqueues.length - 1].forceNew).toBe(true);
    expect(jobs.ran[jobs.ran.length - 1]).toBe(body.jobId);
  });

  it("does not reuse a job that failed", async () => {
    await post({ exportPath: EXPORT, pieceId: "p1" });
    const last = jobs.enqueues[jobs.enqueues.length - 1];
    jobs.terminal.set(JSON.stringify(last.params), { jobId: "job-1", status: "failed", result: null });

    const res = await post({ exportPath: EXPORT, pieceId: "p1" });
    expect((await res.json()).reused).toBeUndefined();
    expect(jobs.enqueues[jobs.enqueues.length - 1].forceNew).toBe(true);
  });

  it("422s a path that is not one of the user's exports, before touching the job layer", async () => {
    vi.resetModules();
    vi.doMock("@/lib/social/fit-check", () => ({ isAllowedExportPath: () => false }));
    const { POST } = await import("@/app/api/social/upload/route");
    const res = await POST(new Request("http://x/api/social/upload", { method: "POST", body: JSON.stringify({ exportPath: "/etc/passwd", pieceId: "p1" }) }));
    expect(res.status).toBe(422);
    vi.doUnmock("@/lib/social/fit-check");
    vi.resetModules();
  });
});

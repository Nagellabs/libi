import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod/v3";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";
import {
  __resetPaidJobRateLimiterForTests,
  PAID_JOB_RATE_LIMIT,
} from "@/lib/jobs/rate-limit";
import { jobs, pieces, files } from "@/lib/db/schema/sqlite";

/** Resolvers for pending runner promises, drained in `afterEach` so no
 *  `runToCompletion` promise outlives the test that registered it. */
const pendingResolvers: Array<() => void> = [];

describe("POST /api/jobs", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    __resetPaidJobRateLimiterForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });

  afterEach(() => {
    // Release any pending runner promises so background `runToCompletion`
    // calls can complete and don't leak across tests.
    while (pendingResolvers.length > 0) {
      pendingResolvers.pop()?.();
    }
  });

  function installMgr(): JobManager {
    const mgr = new JobManager();
    (globalThis as { __libiJobManager?: unknown }).__libiJobManager = mgr;
    return mgr;
  }

  it("rejects malformed body with 400 (invalid JSON)", async () => {
    installMgr();
    const { POST } = await import("@/app/api/jobs/route");
    const res = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: "not-json",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });

  it("rejects malformed body with 400 (missing kind)", async () => {
    installMgr();
    const { POST } = await import("@/app/api/jobs/route");
    const res = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: JSON.stringify({ params: {} }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid body");
    expect(json.issues).toBeDefined();
  });

  it("returns 400 when kind has no registered runner", async () => {
    installMgr();
    const { POST } = await import("@/app/api/jobs/route");
    const res = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: JSON.stringify({ kind: "nonexistent", params: {} }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/No runner registered/);
  });

  it("returns 200 with { status: 'new', jobId, clientKey } on valid enqueue", async () => {
    registerRunner({
      kind: "stub",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ v: z.string() }),
      async run() {
        return { ok: true };
      },
    });
    installMgr();
    const { POST } = await import("@/app/api/jobs/route");
    const res = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: JSON.stringify({ kind: "stub", params: { v: "a" } }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("new");
    expect(typeof json.jobId).toBe("string");
    expect(json.jobId).toMatch(/^job-/);
    expect(typeof json.clientKey).toBe("string");
  });

  it("dedupes a second enqueue with same params while still in-flight → status: 'attached_running'", async () => {
    // Keep the run pending so the job stays non-terminal between calls, but
    // use a resolvable promise so `afterEach` can drain it cleanly.
    const pending = new Promise<void>((resolve) => {
      pendingResolvers.push(resolve);
    });
    registerRunner({
      kind: "stub",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ v: z.string() }),
      async run() {
        await pending;
        return { ok: true };
      },
    });
    installMgr();
    const { POST } = await import("@/app/api/jobs/route");

    const res1 = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: JSON.stringify({ kind: "stub", params: { v: "dup" } }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.status).toBe("new");

    // Give the runner a moment to flip the row to running.
    await new Promise((r) => setTimeout(r, 20));

    const res2 = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: JSON.stringify({ kind: "stub", params: { v: "dup" } }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.status).toBe("attached_running");
    expect(json2.jobId).toBe(json1.jobId);
    expect(json2.existingJob.jobId).toBe(json1.jobId);
  });

  it("returns 400 { error: 'invalid params', issues } when runner schema rejects params", async () => {
    registerRunner({
      kind: "stub",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ v: z.string() }),
      async run() {
        return { ok: true };
      },
    });
    installMgr();
    const { POST } = await import("@/app/api/jobs/route");
    const res = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: JSON.stringify({ kind: "stub", params: { v: 123 } }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid params");
    expect(Array.isArray(json.issues)).toBe(true);
    expect(json.issues.length).toBeGreaterThan(0);
    const hasVIssue = json.issues.some((issue: { path?: unknown[] }) =>
      Array.isArray(issue.path) && issue.path.includes("v"),
    );
    expect(hasVIssue).toBe(true);
  });

  it("persists pieceId and fileId on the job row when provided", async () => {
    // Seed the FK targets (test DB enforces foreign keys).
    const db = getDb() as unknown as ReturnType<typeof createTestDb>;
    db.insert(pieces).values({ id: "p1", name: "Piece 1" }).run();
    db.insert(files).values({
      id: "f1",
      pieceId: "p1",
      filename: "a.mp4",
      name: "a.mp4",
      description: "",
      type: "video",
      storagePath: "p1/a.mp4",
    }).run();

    const pending = new Promise<void>((resolve) => {
      pendingResolvers.push(resolve);
    });
    registerRunner({
      kind: "stub",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({ v: z.string() }),
      async run() {
        await pending;
        return { ok: true };
      },
    });
    installMgr();
    const { POST } = await import("@/app/api/jobs/route");
    const res = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          kind: "stub",
          params: { v: "x" },
          pieceId: "p1",
          fileId: "f1",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const jobId = json.jobId as string;

    const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    expect(row).toBeDefined();
    expect(row?.pieceId).toBe("p1");
    expect(row?.fileId).toBe("f1");
  });

  it("rate-limits the (N+1)th paid enqueue with 429 { error: 'rate_limited' }", async () => {
    // Register a stub flagged `paid: true` so enqueue succeeds but the route's
    // pre-enqueue rate check fires on it. isPaidJobKind now derives "paid" from
    // the registered runner's flag (not a hardcoded kind list), so the stub
    // MUST carry the flag to be treated as a cost-bearing kind.
    const pending = new Promise<void>((resolve) => {
      pendingResolvers.push(resolve);
    });
    registerRunner({
      kind: "extra_analysis_model",
      maxConcurrent: 8,
      resumable: false,
      paid: true,
      paramsSchema: z.object({ v: z.number() }),
      async run() {
        await pending;
        return { ok: true };
      },
    });
    installMgr();
    const { POST } = await import("@/app/api/jobs/route");

    const post = (v: number) =>
      POST(
        new Request("http://x/api/jobs", {
          method: "POST",
          // Distinct params each call so dedupe never collapses them.
          body: JSON.stringify({ kind: "extra_analysis_model", params: { v } }),
          headers: { "Content-Type": "application/json" },
        }),
      );

    // First N paid enqueues pass.
    for (let i = 0; i < PAID_JOB_RATE_LIMIT; i++) {
      const res = await post(i);
      expect(res.status).toBe(200);
    }

    // The (N+1)th is rejected with 429.
    const limited = await post(PAID_JOB_RATE_LIMIT);
    expect(limited.status).toBe(429);
    const json = await limited.json();
    expect(json.error).toBe("rate_limited");
    expect(typeof json.retryAfterMs).toBe("number");
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  it("never rate-limits a non-paid kind, even far past the paid limit", async () => {
    registerRunner({
      kind: "stub",
      maxConcurrent: 50,
      resumable: false,
      paramsSchema: z.object({ v: z.number() }),
      async run() {
        return { ok: true };
      },
    });
    installMgr();
    const { POST } = await import("@/app/api/jobs/route");

    for (let i = 0; i < PAID_JOB_RATE_LIMIT * 3; i++) {
      const res = await POST(
        new Request("http://x/api/jobs", {
          method: "POST",
          body: JSON.stringify({ kind: "stub", params: { v: i } }),
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(res.status).toBe(200);
    }
  });
});

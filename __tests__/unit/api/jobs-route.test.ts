import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";
import { jobIdOf } from "../../helpers/enqueue";

describe("/api/jobs/[id]", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });

  it("GET returns the status snapshot", async () => {
    registerRunner({
      kind: "k", maxConcurrent: 1, resumable: false,
      paramsSchema: z.object({}),
      async run() { return { ok: true }; },
    });
    const mgr = new JobManager();
    (globalThis as { __libiJobManager?: unknown }).__libiJobManager = mgr;
    const jobId = jobIdOf(await mgr.enqueue("k", {}));

    const { GET } = await import("@/app/api/jobs/[id]/route");
    const res = await GET(new Request(`http://x/api/jobs/${jobId}`), {
      params: Promise.resolve({ id: jobId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(jobId);
    expect(json.kind).toBe("k");
    expect(json.status).toBe("queued");
  });

  it("GET 404 when unknown", async () => {
    const { GET } = await import("@/app/api/jobs/[id]/route");
    const res = await GET(new Request("http://x/api/jobs/nope"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE transitions to cancel-requested", async () => {
    registerRunner({
      kind: "k", maxConcurrent: 1, resumable: false,
      paramsSchema: z.object({}),
      async run() { return { ok: true }; },
    });
    const mgr = new JobManager();
    (globalThis as { __libiJobManager?: unknown }).__libiJobManager = mgr;
    const jobId = jobIdOf(await mgr.enqueue("k", {}));
    const { DELETE } = await import("@/app/api/jobs/[id]/route");
    const res = await DELETE(new Request(`http://x/api/jobs/${jobId}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: jobId }),
    });
    expect(res.status).toBe(200);
    const snap = await mgr.getStatus(jobId);
    expect(snap.status).toBe("cancel-requested");
  });

  it("SSE stream for job A is not affected by job B completing", async () => {
    registerRunner({
      kind: "k", maxConcurrent: 4, resumable: false,
      paramsSchema: z.object({ v: z.string() }),
      async run(ctx) {
        // Stay running until externally completed (we'll emit via mgr methods).
        return { id: (ctx.params as { v: string }).v };
      },
    });
    const mgr = new JobManager();
    (globalThis as { __libiJobManager?: unknown }).__libiJobManager = mgr;

    const aId = jobIdOf(await mgr.enqueue("k", { v: "A" }));
    const bId = jobIdOf(await mgr.enqueue("k", { v: "B" }));

    // Open SSE for A.
    const { GET } = await import("@/app/api/jobs/[id]/events/route");
    const res = await GET(new Request(`http://x/api/jobs/${aId}/events`), {
      params: Promise.resolve({ id: aId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/event-stream/);

    // Manually emit a completed event for B (simulating B finishing first).
    // The A-scoped listener must NOT consume it.
    mgr.emit("completed", { jobId: bId });

    // Now emit for A.
    mgr.emit("completed", { jobId: aId });

    // Drain a small chunk from the stream and confirm we see the snapshot + A's completed.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
      if (accumulated.includes("event: completed")) break;
    }
    expect(accumulated).toContain("event: completed");
    expect(accumulated).toContain(`"jobId":"${aId}"`);
    // Must NOT contain the B id, as B's completed event should have been filtered out.
    expect(accumulated).not.toContain(`"jobId":"${bId}"`);
  });
});

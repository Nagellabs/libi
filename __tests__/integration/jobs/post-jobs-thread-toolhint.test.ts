import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";

/**
 * Integration test: POST /api/jobs attaches the supplied `toolHint` to the
 * JobManager BEFORE `runToCompletion` runs, so the very first progress tick
 * emitted by the runner already carries the hint fields
 * (toolName/toolArgs/progressLabel) the session bridge matches on.
 *
 * History: this file previously asserted the `toolCallId` threading, which
 * was deleted by the 2026-07-04 chat tool-call correctness work — the
 * threaded value was the MCP progressToken (a per-request counter), never a
 * real ACP toolCallId, so exact correlation could not work. The `toolHint`
 * is its replacement (spec 2026-07-04-chat-toolcall-status-design.md §B).
 *
 * The test exercises the real route handler, the real JobManager (via the
 * `globalThis.__libiJobManager` singleton hook the route uses), the real
 * registry, and an in-memory DB. Only `@/mcp/notify` is mocked so we can
 * inspect the emitted progress events.
 */

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/mcp/notify", () => ({
  notify: {
    jobProgress: vi.fn(),
  },
}));

import { getDb } from "@/lib/db/client";
import { notify } from "@/mcp/notify";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";

describe("POST /api/jobs threads toolHint", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    vi.clearAllMocks();
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });

  afterEach(() => {
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });

  it("attaches the toolHint before runToCompletion so the first progress tick already carries it", async () => {
    // Block the runner from emitting progress until the test releases it.
    // This guarantees `attachToolHint` (called synchronously after `enqueue`
    // returns in the route handler) lands BEFORE `reportProgress`, even
    // though `runToCompletion` is fire-and-forget.
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });

    registerRunner({
      kind: "k_hint",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run(ctx) {
        await runnerGate;
        ctx.reportProgress(1, 1, "items");
        return { ok: true };
      },
    });

    const mgr = new JobManager();
    (globalThis as { __libiJobManager?: unknown }).__libiJobManager = mgr;

    const { POST } = await import("@/app/api/jobs/route");
    const res = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          kind: "k_hint",
          params: {},
          toolHint: {
            toolName: "libi.dev_slow_job",
            toolArgs: { seconds: 5, nested: { a: [1, 2] } },
            progressLabel: "segment 1/2",
          },
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: "new"; jobId: string; clientKey: string };
    expect(json.status).toBe("new");
    expect(json.jobId).toMatch(/^job-/);

    // Route returned. Now release the runner so the first progress tick fires.
    releaseRunner();

    // Wait for the progress chain to drain.
    await new Promise((r) => setTimeout(r, 100));

    const calls = vi
      .mocked(notify.jobProgress)
      .mock.calls.filter(([arg]) => arg.jobId === json.jobId);
    expect(calls.length).toBeGreaterThan(0);

    // The FIRST progress event must carry the hint — proves the route
    // attached it before the runner started emitting. Non-string toolArgs
    // values (objects, arrays) must survive the route → manager round trip.
    expect(calls[0][0].toolName).toBe("libi.dev_slow_job");
    expect(calls[0][0].toolArgs).toEqual({ seconds: 5, nested: { a: [1, 2] } });
    expect(calls[0][0].progressLabel).toBe("segment 1/2");
  });

  it("omits the hint fields when the body does not include a toolHint", async () => {
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });

    registerRunner({
      kind: "k_no_hint",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run(ctx) {
        await runnerGate;
        ctx.reportProgress(1, 1, "items");
        return { ok: true };
      },
    });

    const mgr = new JobManager();
    (globalThis as { __libiJobManager?: unknown }).__libiJobManager = mgr;

    const { POST } = await import("@/app/api/jobs/route");
    const res = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: JSON.stringify({ kind: "k_no_hint", params: {} }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { jobId: string };

    releaseRunner();
    await new Promise((r) => setTimeout(r, 100));

    const calls = vi
      .mocked(notify.jobProgress)
      .mock.calls.filter(([arg]) => arg.jobId === json.jobId);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0].toolName).toBeUndefined();
    expect(calls[0][0].toolArgs).toBeUndefined();
    expect(calls[0][0].progressLabel).toBeUndefined();
  });

  it("rejects the deleted legacy toolCallId field silently (unknown keys are stripped, no attach happens)", async () => {
    let releaseRunner!: () => void;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });

    registerRunner({
      kind: "k_legacy",
      maxConcurrent: 1,
      resumable: false,
      paramsSchema: z.object({}),
      async run(ctx) {
        await runnerGate;
        ctx.reportProgress(1, 1, "items");
        return { ok: true };
      },
    });

    const mgr = new JobManager();
    (globalThis as { __libiJobManager?: unknown }).__libiJobManager = mgr;

    const { POST } = await import("@/app/api/jobs/route");
    const res = await POST(
      new Request("http://x/api/jobs", {
        method: "POST",
        body: JSON.stringify({ kind: "k_legacy", params: {}, toolCallId: "tool-abc" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { jobId: string };

    releaseRunner();
    await new Promise((r) => setTimeout(r, 100));

    const calls = vi
      .mocked(notify.jobProgress)
      .mock.calls.filter(([arg]) => arg.jobId === json.jobId);
    expect(calls.length).toBeGreaterThan(0);
    // The legacy field must not resurface as a threaded toolCallId.
    expect(calls[0][0].toolCallId).toBeUndefined();
  });
});

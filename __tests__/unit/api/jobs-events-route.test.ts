/**
 * SSE route for live job progress: terminal-event payload contract +
 * late-subscribe fix.
 *
 * Two things this test pins down:
 *
 * 1. **Payload contract.** When a job completes/fails *while* a client is
 *    subscribed, the SSE stream MUST emit a `completed` event carrying the
 *    runner's `result` (already parsed, not a JSON string) and a `failed`
 *    event carrying `error: string`. The chat UI + the MCP-side HTTP client
 *    rely on these exact shapes.
 *
 * 2. **Late-subscribe fix.** If a client subscribes AFTER the job is already
 *    terminal, the manager will never fire another event for that jobId.
 *    The route MUST detect the terminal snapshot status on open, synthesize
 *    the matching `completed | failed | cancelled` event from the snapshot,
 *    and close the stream — otherwise the MCP HTTP client (Task 3) hangs on
 *    any fast/deduped job.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod/v3";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";
import { jobIdOf } from "../../helpers/enqueue";

/** Resolve any pending runner promises in afterEach so background work
 *  doesn't outlive the test that created it. */
const pendingResolvers: Array<() => void> = [];

function installMgr(): JobManager {
  const mgr = new JobManager();
  (globalThis as { __libiJobManager?: unknown }).__libiJobManager = mgr;
  return mgr;
}

/**
 * Read SSE events from a Response body until either `predicate` returns true
 * for at least one parsed event, or the stream closes, or the timeout hits.
 *
 * Returns ALL events parsed so far. Each event is `{ event, data }` where
 * `data` is parsed JSON.
 */
async function readSseUntil(
  res: Response,
  predicate: (event: { event: string; data: unknown }) => boolean,
  timeoutMs = 1500,
): Promise<{
  events: Array<{ event: string; data: unknown }>;
  streamClosed: boolean;
}> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: Array<{ event: string; data: unknown }> = [];
  let buffer = "";
  let streamClosed = false;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(0, deadline - Date.now());
      const readPromise = reader.read();
      const TIMEOUT_SENTINEL = Symbol("timeout");
      const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
        setTimeout(() => resolve(TIMEOUT_SENTINEL), remaining),
      );
      const r = await Promise.race([readPromise, timeout]);
      if (r === TIMEOUT_SENTINEL) break;
      if (r.done) {
        streamClosed = true;
        break;
      }
      buffer += r.value ?? "";
      // SSE frames are separated by blank lines.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const eventMatch = frame.match(/^event: (.+)$/m);
        const dataMatch = frame.match(/^data: (.+)$/m);
        if (eventMatch && dataMatch) {
          events.push({
            event: eventMatch[1],
            data: JSON.parse(dataMatch[1]),
          });
        }
      }
      // After matching predicate, keep reading — the route closes the stream
      // immediately after the terminal event, so the next read() should
      // resolve with `done: true` on the same microtask tick.
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return { events, streamClosed };
}

describe("GET /api/jobs/[id]/events", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });

  afterEach(() => {
    while (pendingResolvers.length > 0) {
      pendingResolvers.pop()?.();
    }
  });

  async function openSse(jobId: string): Promise<Response> {
    const { GET } = await import("@/app/api/jobs/[id]/events/route");
    return GET(new Request(`http://x/api/jobs/${jobId}/events`), {
      params: Promise.resolve({ id: jobId }),
    });
  }

  describe("terminal payload contract (live subscribe)", () => {
    it("emits a `completed` event carrying the runner's result", async () => {
      // Block the runner until the test releases it, so we can subscribe
      // BEFORE the job finishes and watch the live `completed` event.
      const release = new Promise<void>((resolve) => {
        pendingResolvers.push(resolve);
      });
      const expected = { ok: true, value: 42 };
      registerRunner({
        kind: "stub",
        maxConcurrent: 1,
        resumable: false,
        paramsSchema: z.object({ v: z.string() }),
        async run() {
          await release;
          return expected;
        },
      });
      const mgr = installMgr();
      const jobId = jobIdOf(await mgr.enqueue("stub", { v: "live-completed" }));
      const runPromise = mgr.runToCompletion(jobId);

      const res = await openSse(jobId);
      expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);

      // Release the runner — now the live `completed` event will fire.
      pendingResolvers.pop()?.();
      await runPromise;

      const { events, streamClosed } = await readSseUntil(
        res,
        (e) => e.event === "completed",
      );
      const completed = events.find((e) => e.event === "completed");
      expect(completed).toBeDefined();
      expect(completed!.data).toMatchObject({ jobId, result: expected });
      expect(streamClosed).toBe(true);
    });

    it("emits a `failed` event carrying error: string", async () => {
      const release = new Promise<void>((resolve) => {
        pendingResolvers.push(resolve);
      });
      registerRunner({
        kind: "stub",
        maxConcurrent: 1,
        resumable: false,
        paramsSchema: z.object({ v: z.string() }),
        async run() {
          await release;
          throw new Error("boom-live");
        },
      });
      const mgr = installMgr();
      const jobId = jobIdOf(await mgr.enqueue("stub", { v: "live-failed" }));
      const runPromise = mgr.runToCompletion(jobId).catch(() => {
        // We expect this to reject — swallow so the test doesn't fail on it.
      });

      const res = await openSse(jobId);
      pendingResolvers.pop()?.();
      await runPromise;

      const { events } = await readSseUntil(res, (e) => e.event === "failed");
      const failed = events.find((e) => e.event === "failed");
      expect(failed).toBeDefined();
      const data = failed!.data as { jobId: string; error: string };
      expect(data.jobId).toBe(jobId);
      expect(typeof data.error).toBe("string");
      expect(data.error).toMatch(/boom-live/);
    });
  });

  describe("late-subscribe fix (subscribe after terminal)", () => {
    it("synthesizes `completed` event from snapshot and closes the stream", async () => {
      const expected = { hello: "world", n: 7 };
      registerRunner({
        kind: "stub",
        maxConcurrent: 1,
        resumable: false,
        paramsSchema: z.object({ v: z.string() }),
        async run() {
          return expected;
        },
      });
      const mgr = installMgr();
      const jobId = jobIdOf(await mgr.enqueue("stub", { v: "late-completed" }));
      // Run to completion FIRST, then open SSE — the manager has already
      // emitted its `completed` event before we attach any listener.
      await mgr.runToCompletion(jobId);

      const res = await openSse(jobId);
      const { events, streamClosed } = await readSseUntil(
        res,
        (e) => e.event === "completed",
      );

      const snapshot = events.find((e) => e.event === "snapshot");
      const completed = events.find((e) => e.event === "completed");
      expect(snapshot).toBeDefined();
      expect((snapshot!.data as { status: string }).status).toBe("completed");
      expect(completed).toBeDefined();
      expect(completed!.data).toMatchObject({ jobId, result: expected });
      // Stream should be closed (route called controller.close after finish()).
      expect(streamClosed).toBe(true);
    });

    it("synthesized `completed` omits `result` field when runner returned undefined", async () => {
      // Shape parity with the live path: `JSON.stringify({ jobId, result: undefined })`
      // omits the `result` key, so SSE data is `{"jobId":"..."}`. The synthesized
      // path must match — otherwise the MCP HTTP client (Task 3) sees an
      // inconsistent shape between fast/deduped jobs (synthesized) and slow
      // ones (live).
      registerRunner<{ v: string }, void>({
        kind: "stub",
        maxConcurrent: 1,
        resumable: false,
        paramsSchema: z.object({ v: z.string() }),
        async run() {
          // returns undefined — markCompleted ends up calling
          // markCompleted(id, JSON.stringify(undefined)) → resultJson stays null
        },
      });
      const mgr = installMgr();
      const jobId = jobIdOf(await mgr.enqueue("stub", { v: "void-result" }));
      await mgr.runToCompletion(jobId);

      const res = await openSse(jobId);
      const { events } = await readSseUntil(
        res,
        (e) => e.event === "completed",
      );
      const completed = events.find((e) => e.event === "completed");
      expect(completed).toBeDefined();
      const data = completed!.data as Record<string, unknown>;
      // The whole point of the parity fix: when there's no result, the field
      // is absent entirely, not present-with-null.
      expect(data).toEqual({ jobId });
      expect("result" in data).toBe(false);
    });

    it("synthesizes `failed` event from snapshot and closes the stream", async () => {
      registerRunner({
        kind: "stub",
        maxConcurrent: 1,
        resumable: false,
        paramsSchema: z.object({ v: z.string() }),
        async run() {
          throw new Error("late-boom");
        },
      });
      const mgr = installMgr();
      const jobId = jobIdOf(await mgr.enqueue("stub", { v: "late-failed" }));
      await mgr.runToCompletion(jobId).catch(() => {
        /* expected */
      });

      const res = await openSse(jobId);
      const { events, streamClosed } = await readSseUntil(
        res,
        (e) => e.event === "failed",
      );
      const snapshot = events.find((e) => e.event === "snapshot");
      const failed = events.find((e) => e.event === "failed");
      expect(snapshot).toBeDefined();
      expect((snapshot!.data as { status: string }).status).toBe("failed");
      expect(failed).toBeDefined();
      const data = failed!.data as { jobId: string; error: string };
      expect(data.jobId).toBe(jobId);
      expect(typeof data.error).toBe("string");
      expect(data.error).toMatch(/late-boom/);
      expect(streamClosed).toBe(true);
    });

    it("synthesizes `cancelled` event from snapshot and closes the stream", async () => {
      // Hold the runner indefinitely so we can cancel it cleanly.
      const release = new Promise<void>((resolve) => {
        pendingResolvers.push(resolve);
      });
      registerRunner({
        kind: "stub",
        maxConcurrent: 1,
        resumable: false,
        paramsSchema: z.object({ v: z.string() }),
        async run(ctx) {
          // Poll cancellation while waiting for release. Manager's cancel
          // path aborts via AbortController too, but stub doesn't see that
          // unless we check shouldCancel.
          while (!ctx.shouldCancel()) {
            await Promise.race([
              release,
              new Promise((r) => setTimeout(r, 5)),
            ]);
            if (ctx.shouldCancel()) break;
            // Break out once release fires too, so the test can clean up.
            const raced = await Promise.race([
              release.then(() => "released" as const),
              Promise.resolve("tick" as const),
            ]);
            if (raced === "released") break;
          }
          // Throw the way the runner contract requires for cancellation.
          if (ctx.shouldCancel()) {
            const { CancelledError } = await import("@/lib/jobs/types");
            throw new CancelledError(ctx.jobId);
          }
          return { ok: true };
        },
      });
      const mgr = installMgr();
      const jobId = jobIdOf(await mgr.enqueue("stub", { v: "late-cancelled" }));
      const runPromise = mgr.runToCompletion(jobId).catch(() => {
        /* expected */
      });
      // Cancel and wait for the manager to fully process it.
      await mgr.cancel(jobId);
      // Release so the runner can break out and the manager finishes.
      pendingResolvers.pop()?.();
      await runPromise;

      const res = await openSse(jobId);
      const { events, streamClosed } = await readSseUntil(
        res,
        (e) => e.event === "cancelled",
      );
      const snapshot = events.find((e) => e.event === "snapshot");
      const cancelled = events.find((e) => e.event === "cancelled");
      expect(snapshot).toBeDefined();
      expect((snapshot!.data as { status: string }).status).toBe("cancelled");
      expect(cancelled).toBeDefined();
      expect(cancelled!.data).toMatchObject({ jobId });
      expect(streamClosed).toBe(true);
    });
  });
});

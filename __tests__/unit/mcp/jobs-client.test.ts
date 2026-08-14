/**
 * MCP child's HTTP+SSE client for invoking JobManager jobs.
 *
 * This test pins down:
 *   1. `enqueueJobOnServer` response handling — 200/400/500 + connection
 *      refused + port-file missing.
 *   2. `runJobViaServer` SSE consumption — progress forwarding shape,
 *      terminal events (completed/failed/cancelled), abort, early close.
 *
 * The progress notification shape is byte-checked against
 * `lib/jobs/progress-forwarder.ts` — the `claude-agent-acp` adapter relies
 * on `{ method: "notifications/progress", params: { progressToken, progress,
 * total, message } }` to surface `tool_call_update` events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/libi-home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/libi-home")>();
  return {
    ...actual,
    getCurrentPort: vi.fn(() => 19999),
  };
});

import { getCurrentPort } from "@/lib/libi-home";
import {
  enqueueJobOnServer,
  runJobViaServer,
  LibiServerUnavailableError,
  getJobStatusFromServer,
  cancelJobOnServer,
} from "@/mcp/jobs-client";
import { CancelledError } from "@/lib/jobs/types";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const getCurrentPortMock = vi.mocked(getCurrentPort);

function makeSseResponse(
  frames: Array<{ event: string; data: unknown }>,
  opts: { close?: boolean } = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const f of frames) {
        c.enqueue(
          encoder.encode(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`),
        );
      }
      if (opts.close !== false) c.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Build an SSE response where frames are dripped in over multiple chunks and
 * frame boundaries land mid-chunk — exercises the partial-frame buffer.
 */
function makeChunkedSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(encoder.encode(ch));
      c.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("mcp/jobs-client", () => {
  beforeEach(() => {
    getCurrentPortMock.mockReset();
    getCurrentPortMock.mockReturnValue(19999);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("enqueueJobOnServer", () => {
    it("returns the EnqueueResult union (status:'new') on 200", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              status: "new",
              jobId: "job-1",
              clientKey: "ck-1",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );

      const result = await enqueueJobOnServer(
        "proxy_gen",
        { fileId: "f1" },
        { pieceId: "p1", fileId: "f1" },
      );

      expect(result).toEqual({
        status: "new",
        jobId: "job-1",
        clientKey: "ck-1",
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:19999/api/jobs",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
      const calledBody = JSON.parse(
        (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
      );
      expect(calledBody).toEqual({
        kind: "proxy_gen",
        params: { fileId: "f1" },
        pieceId: "p1",
        fileId: "f1",
      });
    });

    it("throws Error(body.error) on 400", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid params" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(
        enqueueJobOnServer("proxy_gen", { fileId: "f1" }),
      ).rejects.toThrow("invalid params");
    });

    it("throws LibiServerUnavailableError on connection refused", async () => {
      const refused = new TypeError("fetch failed");
      (refused as { cause?: { code: string } }).cause = { code: "ECONNREFUSED" };
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(refused);

      await expect(
        enqueueJobOnServer("proxy_gen", { fileId: "f1" }),
      ).rejects.toBeInstanceOf(LibiServerUnavailableError);
    });

    it("throws LibiServerUnavailableError when port file is missing", async () => {
      getCurrentPortMock.mockImplementation(() => {
        throw new Error("no port file");
      });

      await expect(
        enqueueJobOnServer("proxy_gen", { fileId: "f1" }),
      ).rejects.toBeInstanceOf(LibiServerUnavailableError);
    });

    it("throws 'internal server error' on 500", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "internal" }), {
          status: 500,
        }),
      );

      await expect(
        enqueueJobOnServer("proxy_gen", { fileId: "f1" }),
      ).rejects.toThrow("internal server error");
    });
  });

  describe("runJobViaServer", () => {
    function mockEnqueueThenSse(
      jobId: string,
      sseResponse: Response,
    ): ReturnType<typeof vi.spyOn> {
      return vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ status: "new", jobId, clientKey: `ck-${jobId}` }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        )
        .mockResolvedValueOnce(sseResponse);
    }

    it("forwards progress as MCP notifications and resolves on completed", async () => {
      const sse = makeSseResponse([
        { event: "snapshot", data: { id: "job-1", status: "running" } },
        {
          event: "progress",
          data: {
            jobId: "job-1",
            kind: "tracking",
            done: 1,
            total: 10,
            unit: "frames",
          },
        },
        {
          event: "progress",
          data: {
            jobId: "job-1",
            kind: "tracking",
            done: 5,
            total: 10,
            unit: "frames",
          },
        },
        {
          event: "progress",
          data: {
            jobId: "job-1",
            kind: "tracking",
            done: 10,
            total: 10,
            unit: "frames",
          },
        },
        {
          event: "completed",
          data: { jobId: "job-1", result: { ok: true, count: 10 } },
        },
      ]);
      mockEnqueueThenSse("job-1", sse);

      const sendNotification = vi.fn().mockResolvedValue(undefined);

      const result = await runJobViaServer<{ ok: boolean; count: number }>(
        "tracking",
        { fileId: "f1" },
        {
          extra: {
            sendNotification,
            _meta: { progressToken: "tok-abc" },
          } as unknown as ToolExtra,
        },
      );

      expect(result.status).toBe("new");
      if (result.status === "new") {
        expect(result.result).toEqual({ ok: true, count: 10 });
        expect(result.jobId).toBe("job-1");
        expect(result.clientKey).toBe("ck-job-1");
      }
      expect(sendNotification).toHaveBeenCalledTimes(3);
      expect(sendNotification).toHaveBeenNthCalledWith(1, {
        method: "notifications/progress",
        params: {
          progressToken: "tok-abc",
          progress: 1,
          total: 10,
          message: "1/10 frames",
        },
      });
      expect(sendNotification).toHaveBeenNthCalledWith(3, {
        method: "notifications/progress",
        params: {
          progressToken: "tok-abc",
          progress: 10,
          total: 10,
          message: "10/10 frames",
        },
      });
    });

    it("rejects with Error(data.error) on failed event", async () => {
      const sse = makeSseResponse([
        { event: "failed", data: { jobId: "job-1", error: "boom" } },
      ]);
      mockEnqueueThenSse("job-1", sse);

      await expect(
        runJobViaServer("tracking", { fileId: "f1" }),
      ).rejects.toThrow("boom");
    });

    it("rejects with CancelledError on cancelled event", async () => {
      const sse = makeSseResponse([
        { event: "cancelled", data: { jobId: "job-1" } },
      ]);
      mockEnqueueThenSse("job-1", sse);

      await expect(
        runJobViaServer("tracking", { fileId: "f1" }),
      ).rejects.toBeInstanceOf(CancelledError);
    });

    it("aborts the SSE reader and rejects when caller aborts mid-stream", async () => {
      // Build a stream that emits one progress then hangs — until we cancel.
      const encoder = new TextEncoder();
      let cancelled = false;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              `event: progress\ndata: ${JSON.stringify({
                jobId: "job-1",
                done: 1,
                total: 10,
                unit: "frames",
              })}\n\n`,
            ),
          );
          // Intentionally do NOT close — simulate a long-running job.
        },
        cancel() {
          cancelled = true;
        },
      });
      const sseResponse = new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });

      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ status: "new", jobId: "job-1", clientKey: "ck-job-1" }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(sseResponse);

      const ac = new AbortController();
      const sendNotification = vi.fn().mockResolvedValue(undefined);
      const promise = runJobViaServer("tracking", { fileId: "f1" }, {
        signal: ac.signal,
        extra: {
          sendNotification,
          _meta: { progressToken: "tok" },
        } as unknown as ToolExtra,
      });

      // Yield so the first progress event flushes through the reader.
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();

      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
      // Give the finally block a tick to call reader.cancel which propagates
      // back to the underlying stream's cancel() callback.
      await new Promise((r) => setTimeout(r, 10));
      expect(cancelled).toBe(true);
    });

    it("does NOT call sendNotification when no progressToken is set", async () => {
      const sse = makeSseResponse([
        {
          event: "progress",
          data: { jobId: "job-1", done: 1, total: 10, unit: "frames" },
        },
        {
          event: "progress",
          data: { jobId: "job-1", done: 10, total: 10, unit: "frames" },
        },
        { event: "completed", data: { jobId: "job-1", result: "done" } },
      ]);
      mockEnqueueThenSse("job-1", sse);

      const sendNotification = vi.fn().mockResolvedValue(undefined);
      const result = await runJobViaServer<string>(
        "tracking",
        { fileId: "f1" },
        {
          extra: {
            sendNotification,
            _meta: {}, // no progressToken
          } as unknown as ToolExtra,
        },
      );

      expect(result.status).toBe("new");
      if (result.status === "new") {
        expect(result.result).toBe("done");
        expect(result.jobId).toBe("job-1");
      }
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("rejects with 'SSE closed before terminal event' when stream closes early", async () => {
      const sse = makeSseResponse([
        {
          event: "progress",
          data: { jobId: "job-1", done: 1, total: 10, unit: "frames" },
        },
      ]);
      mockEnqueueThenSse("job-1", sse);

      await expect(
        runJobViaServer("tracking", { fileId: "f1" }),
      ).rejects.toThrow("SSE closed before terminal event");
    });

    it("handles SSE frames split across multiple chunks", async () => {
      // The terminal "completed" event is split across two chunks at the
      // newline between `data:` and the JSON payload. The parser must wait
      // for the second chunk before emitting the frame.
      const sse = makeChunkedSseResponse([
        "event: progress\ndata: ",
        JSON.stringify({
          jobId: "job-1",
          done: 3,
          total: 10,
          unit: "frames",
        }) + "\n\nevent: comp",
        "leted\ndata: " +
          JSON.stringify({ jobId: "job-1", result: { x: 1 } }) +
          "\n\n",
      ]);
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ status: "new", jobId: "job-1", clientKey: "ck-job-1" }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(sse);

      const sendNotification = vi.fn().mockResolvedValue(undefined);
      const result = await runJobViaServer<{ x: number }>(
        "tracking",
        { fileId: "f1" },
        {
          extra: {
            sendNotification,
            _meta: { progressToken: 42 },
          } as unknown as ToolExtra,
        },
      );

      expect(result.status).toBe("new");
      if (result.status === "new") {
        expect(result.result).toEqual({ x: 1 });
      }
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification).toHaveBeenCalledWith({
        method: "notifications/progress",
        params: {
          progressToken: 42,
          progress: 3,
          total: 10,
          message: "3/10 frames",
        },
      });
    });

    // Regression: a FAILED cached row must not become this call's answer.
    // `libi.ground_target` failed once with `tracking_engine_not_installed`;
    // after the engine was installed and verify_install returned ok, the
    // identical retry still replayed that stored failure because it attached
    // to the terminal row and never re-ran. Only forceNew escapes it, so
    // runJobViaServer does that itself — CLAUDE.md's dedup policy for a
    // failed/cancelled match is "re-run silently with forceNew: true".
    it("re-runs with forceNew when the server matches a FAILED cached row", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        // 1st enqueue → stale failed row
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              status: "matching_completed",
              existingJob: {
                jobId: "job-old",
                status: "failed",
                error: "tracking_engine_not_installed",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        // 2nd enqueue (forceNew) → a real new job
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ status: "new", jobId: "job-new", clientKey: "ck", forced: true }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          makeSseResponse([
            { event: "completed", data: { jobId: "job-new", result: { candidates: [1] } } },
          ]),
        );

      const result = await runJobViaServer<{ candidates: number[] }>(
        "tracking",
        { fileId: "f1" },
      );

      expect(result.status).toBe("new");
      if (result.status === "new") {
        expect(result.jobId).toBe("job-new");
        expect(result.result).toEqual({ candidates: [1] });
      }
      const secondBody = JSON.parse(
        (fetchSpy.mock.calls[1][1] as RequestInit).body as string,
      );
      expect(secondBody.forceNew).toBe(true);
    });

    it("does NOT re-run when the caller already asked for forceNew", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "matching_completed",
            existingJob: { jobId: "job-old", status: "failed", error: "boom" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const result = await runJobViaServer("tracking", { fileId: "f1" }, { forceNew: true });

      expect(result.status).toBe("matching_completed");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("still returns a genuinely COMPLETED cached row without re-running", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "matching_completed",
            existingJob: {
              jobId: "job-old",
              status: "completed",
              result: { candidates: [7] },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const result = await runJobViaServer<{ candidates: number[] }>(
        "tracking",
        { fileId: "f1" },
      );

      expect(result.status).toBe("matching_completed");
      if (result.status === "matching_completed") {
        expect(result.existingJob.result).toEqual({ candidates: [7] });
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("getJobStatusFromServer", () => {
    it("returns the parsed snapshot on 200", async () => {
      const snapshot = {
        id: "job-1",
        kind: "tracking",
        status: "running",
        progressDone: 3,
        progressTotal: 10,
        progressUnit: "frames",
        etaMs: null,
        msPerUnit: null,
        error: null,
        resultJson: null,
        startedAt: null,
        completedAt: null,
        lastProgressAt: null,
      };
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await getJobStatusFromServer("job-1");
      expect(result.id).toBe("job-1");
      expect(result.status).toBe("running");
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:19999/api/jobs/job-1",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws clear error on 404", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      );

      await expect(getJobStatusFromServer("missing")).rejects.toThrow(
        /job not found: missing/,
      );
    });

    it("throws LibiServerUnavailableError on connection refused", async () => {
      const refused = new TypeError("fetch failed");
      (refused as { cause?: { code: string } }).cause = { code: "ECONNREFUSED" };
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(refused);

      await expect(getJobStatusFromServer("job-1")).rejects.toBeInstanceOf(
        LibiServerUnavailableError,
      );
    });

    it("throws LibiServerUnavailableError when port file is missing", async () => {
      getCurrentPortMock.mockImplementation(() => {
        throw new Error("no port file");
      });

      await expect(getJobStatusFromServer("job-1")).rejects.toBeInstanceOf(
        LibiServerUnavailableError,
      );
    });
  });

  describe("cancelJobOnServer", () => {
    it("resolves on 200", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ accepted: true }), { status: 200 }),
      );

      await expect(cancelJobOnServer("job-1")).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:19999/api/jobs/job-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("throws clear error on 404", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      );

      await expect(cancelJobOnServer("missing")).rejects.toThrow(
        /job not found: missing/,
      );
    });

    it("throws LibiServerUnavailableError on connection refused", async () => {
      const refused = new TypeError("fetch failed");
      (refused as { cause?: { code: string } }).cause = { code: "ECONNREFUSED" };
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(refused);

      await expect(cancelJobOnServer("job-1")).rejects.toBeInstanceOf(
        LibiServerUnavailableError,
      );
    });

    it("throws LibiServerUnavailableError when port file is missing", async () => {
      getCurrentPortMock.mockImplementation(() => {
        throw new Error("no port file");
      });

      await expect(cancelJobOnServer("job-1")).rejects.toBeInstanceOf(
        LibiServerUnavailableError,
      );
    });
  });
});

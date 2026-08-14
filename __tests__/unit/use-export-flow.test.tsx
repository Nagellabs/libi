// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useExportFlow } from "@/hooks/editor/use-export-flow";

/**
 * `useExportFlow` POSTs to `/api/export`, then subscribes to
 * `/api/jobs/<id>/events` via EventSource. We mock both.
 */

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }
  removeEventListener(): void { /* noop */ }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    const ls = this.listeners.get(type) ?? [];
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const l of ls) l(ev);
  }
}

describe("useExportFlow", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input === "/api/export") {
          return new Response(JSON.stringify({ jobId: "job-1" }), { status: 200 });
        }
        if (input.startsWith("/api/jobs/") && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return new Response("not mocked", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts idle with null progress and no result", () => {
    const { result } = renderHook(() => useExportFlow());
    expect(result.current.status).toBe("idle");
    expect(result.current.progress).toBeNull();
    expect(result.current.result).toBeNull();
  });

  it("start() enqueues then transitions through running → success when SSE emits completed", async () => {
    const { result } = renderHook(() => useExportFlow());

    await act(async () => {
      await result.current.start({
        pieceId: "p1",
        source: "draft",
        filename: "My Video",
        format: "mp4",
        quality: "source",
      });
    });

    await waitFor(() => expect(result.current.status).toBe("running"));
    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].url).toBe("/api/jobs/job-1/events");

    await act(async () => {
      MockEventSource.instances[0].emit("progress", {
        jobId: "job-1",
        done: 50,
        total: 100,
        unit: "%",
        etaMs: 5000,
      });
    });
    expect(result.current.progress).toEqual({
      done: 50,
      total: 100,
      unit: "%",
      etaMs: 5000,
    });

    await act(async () => {
      MockEventSource.instances[0].emit("completed", {
        jobId: "job-1",
        result: {
          filePath: "/Users/test/Movies/libi/My Video.mp4",
          sizeBytes: 1234,
          durationSeconds: 10,
          backend: "ffmpeg-overlay",
          width: 1920,
          height: 1080,
        },
      });
    });

    expect(result.current.status).toBe("success");
    expect(result.current.result?.filePath).toBe("/Users/test/Movies/libi/My Video.mp4");
  });

  it("transitions to failed when SSE emits failed", async () => {
    const { result } = renderHook(() => useExportFlow());
    await act(async () => {
      await result.current.start({
        pieceId: "p1",
        source: "draft",
        filename: "X",
        format: "mp4",
        quality: "source",
      });
    });
    await waitFor(() => expect(result.current.status).toBe("running"));

    await act(async () => {
      MockEventSource.instances[0].emit("failed", { jobId: "job-1", error: "boom" });
    });

    expect(result.current.status).toBe("failed");
    expect(result.current.error).toBe("boom");
  });

  it("cancel() DELETEs the job", async () => {
    const fetchMock = (global as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
    const { result } = renderHook(() => useExportFlow());
    await act(async () => {
      await result.current.start({
        pieceId: "p1",
        source: "draft",
        filename: "X",
        format: "mp4",
        quality: "source",
      });
    });
    await waitFor(() => expect(result.current.status).toBe("running"));

    await act(async () => {
      await result.current.cancel();
    });

    const lastCall = fetchMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("/api/jobs/job-1");
    expect(lastCall?.[1]?.method).toBe("DELETE");
  });

  it("reset() returns the hook to idle", async () => {
    const { result } = renderHook(() => useExportFlow());
    await act(async () => {
      await result.current.start({
        pieceId: "p1",
        source: "draft",
        filename: "X",
        format: "mp4",
        quality: "source",
      });
    });
    await waitFor(() => expect(result.current.status).toBe("running"));

    await act(async () => {
      MockEventSource.instances[0].emit("failed", { jobId: "job-1", error: "x" });
    });
    expect(result.current.status).toBe("failed");

    act(() => {
      result.current.reset();
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("a failed POST surfaces error and leaves status=failed", async () => {
    (global as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi.fn(async () => {
      return new Response("Piece not found", { status: 404 });
    });
    const { result } = renderHook(() => useExportFlow());
    await act(async () => {
      await result.current.start({
        pieceId: "missing",
        source: "draft",
        filename: "X",
        format: "mp4",
        quality: "source",
      });
    });
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.error).toContain("Piece not found");
  });
});

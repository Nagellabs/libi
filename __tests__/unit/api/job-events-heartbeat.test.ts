/**
 * A long job's SSE stream must not go silent.
 *
 * `/api/jobs/[id]/events` is purely event-driven: after the opening snapshot it
 * emits nothing until the JobManager fires progress. On a long job that
 * progress can be SPARSE — the ACE-Step model download reports once per file,
 * and a single 3 GB safetensors takes many minutes — so the stream produces no
 * bytes at all for long stretches.
 *
 * undici (Node's fetch, which mcp/jobs-client.ts uses to consume this stream)
 * kills a response body that produces nothing for its default timeout. Measured
 * 2026-08-02 on the packaged app: the agent's `music_download_model` call died
 * twice with an opaque `terminated` WHILE THE JOB WAS STILL RUNNING and
 * ultimately succeeded. The agent's only signal was a spurious failure, and its
 * natural response is to retry — re-downloading gigabytes, or reporting a
 * failure the user never had.
 *
 * This is the same defect fixed in `app/api/agent/events/route.ts` (8c4e81aa),
 * left behind in the sibling route — the "fixed one path, left the other"
 * pattern. The heartbeat is an SSE comment, which every conforming parser
 * ignores, so no consumer sees a spurious event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getStatus = vi.hoisted(() => vi.fn());
const on = vi.hoisted(() => vi.fn());
const off = vi.hoisted(() => vi.fn());

vi.mock("@/lib/jobs/manager", () => ({
  getJobManager: () => ({ on, off, getStatus }),
}));

vi.mock("@/lib/logger", () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value } = await reader.read();
  return new TextDecoder().decode(value ?? new Uint8Array());
}

describe("GET /api/jobs/[id]/events keeps the stream alive", () => {
  beforeEach(() => {
    getStatus.mockReset();
    on.mockReset();
    off.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a heartbeat comment while a job runs with no progress events", async () => {
    getStatus.mockResolvedValue({ status: "running", resultJson: null });
    const { GET } = await import("@/app/api/jobs/[id]/events/route");

    // Fake timers MUST be installed before GET: the heartbeat interval is
    // created inside the stream's start(), and an interval scheduled on real
    // timers is not advanced by the fake clock.
    vi.useFakeTimers();

    const res = await GET(new Request("http://localhost/api/jobs/j1/events"), {
      params: Promise.resolve({ id: "j1" }),
    });
    const reader = res.body!.getReader();

    // Opening snapshot (getStatus resolves on a microtask, not a timer).
    const first = await readChunk(reader);
    expect(first).toContain("snapshot");

    // Now go quiet — exactly what a multi-GB single-file download looks like.
    await vi.advanceTimersByTimeAsync(26_000);
    const beat = await readChunk(reader);

    expect(
      beat.startsWith(":"),
      "an idle job stream must emit an SSE comment, or undici kills the body " +
        "and the agent sees `terminated` for a job that is actually fine",
    ).toBe(true);
    expect(beat).not.toContain("event:");

    await reader.cancel().catch(() => {});
  });

  it("stops the heartbeat once the job reaches a terminal state", async () => {
    // A completed job closes the stream; a timer left running would keep a
    // handle alive per finished subscription.
    getStatus.mockResolvedValue({ status: "completed", resultJson: null });
    const { GET } = await import("@/app/api/jobs/[id]/events/route");

    const res = await GET(new Request("http://localhost/api/jobs/j2/events"), {
      params: Promise.resolve({ id: "j2" }),
    });
    const reader = res.body!.getReader();

    let text = "";
    // Drain to close — snapshot + synthesized completed, then done.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("completed");
    // off() ran, which is where clearInterval lives (via detach).
    expect(off).toHaveBeenCalled();
  });
});

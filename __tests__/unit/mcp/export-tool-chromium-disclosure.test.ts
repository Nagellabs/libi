import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `libi.export_video` blocks in `waitForJobCompletion` until the job ends, so
// the only moment the agent can be told "this export starts with a ~173 MB
// download" is between the enqueue response and that wait. The route reports
// `chromiumDownloadMb` at enqueue time; the tool relays
// it as the FIRST progress notification on the call's own progressToken.

vi.mock("@/lib/libi-home", async (orig) => ({
  ...(await orig<typeof import("@/lib/libi-home")>()),
  getCurrentPort: () => 3999,
}));

vi.mock("@/mcp/notify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/mcp/notify")>();
  return { ...mod, notify: { ...mod.notify, toolProgress: vi.fn() } };
});
import { notify } from "@/mcp/notify";
import { runWithToolCallContext } from "@/mcp/tool-call-context";
import { exportVideo } from "@/mcp/tools/export-tools";

function sse(events: Array<{ event: string; data: unknown }>): Response {
  const body = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const COMPLETED = {
  filePath: "/tmp/out.mp4",
  sizeBytes: 10,
  durationSeconds: 2,
  backend: "chromium-render",
  width: 320,
  height: 240,
};

describe("libi.export_video — Chromium download disclosure", () => {
  const realFetch = globalThis.fetch;
  let sendNotification: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendNotification = vi.fn(async () => {});
    vi.mocked(notify.toolProgress).mockClear();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubServer(enqueue: Record<string, unknown>) {
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/export") && init?.method === "POST") {
        return new Response(JSON.stringify({ jobId: "job-1", ...enqueue }), { status: 200 });
      }
      if (url.endsWith("/api/jobs/job-1/events")) {
        return sse([
          { event: "progress", data: { jobId: "job-1", done: 87, total: 173, unit: "MB" } },
          { event: "completed", data: { jobId: "job-1", result: COMPLETED } },
        ]);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
  }

  function extra() {
    return {
      _meta: { progressToken: "tok-1" },
      sendNotification,
    } as unknown as Parameters<typeof exportVideo>[1];
  }

  it("says so before waiting when the route reports a download, and flags it in the result", async () => {
    stubServer({ chromiumDownloadMb: 173 });

    const result = await runWithToolCallContext("libi.export_video", { pieceId: "p1" }, () => exportVideo({ pieceId: "p1" }, extra()));

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.data.chromiumDownloaded).toBe(true);
    // First notification = the disclosure, BEFORE any job progress is relayed.
    expect(sendNotification.mock.calls[0]![0]).toEqual({
      method: "notifications/progress",
      params: {
        progressToken: "tok-1",
        progress: 0,
        total: 173,
        message: "first canvas export downloads Chromium, ~173 MB",
      },
    });
    // The download's own bytes then flow through with their unit.
    expect(sendNotification.mock.calls[1]![0]).toMatchObject({
      params: { progress: 87, total: 173, message: "87/173 MB" },
    });
    expect(notify.toolProgress).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "libi.export_video", done: 0, total: 173, message: "first canvas export downloads Chromium, ~173 MB" }),
    );
  });

  it("stays silent when Chromium is already installed", async () => {
    stubServer({ chromiumDownloadMb: null });

    const result = await exportVideo({ pieceId: "p1" }, extra());

    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect(result.data.chromiumDownloaded).toBe(false);
    expect(
      sendNotification.mock.calls.map((c) => (c[0] as { params: { message: string } }).params.message),
    ).toEqual(["87/173 MB"]);
    expect(notify.toolProgress).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/libi-home", async (orig) => ({ ...(await orig<typeof import("@/lib/libi-home")>()), getCurrentPort: () => 3461 }));
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { exportVideo } from "@/mcp/tools/export-tools";

// A block body: vitest would call the mock itself as a cleanup hook if beforeEach returned it.
beforeEach(() => {
  fetchMock.mockReset();
});

describe("libi.export_video — while it waits", () => {
  it("relays the scheduler's reason from the export's record", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/export")) {
        return new Response(JSON.stringify({ jobId: "job-1", exportId: "exp_1", name: "P", chromiumDownloadMb: null, settings: { format: "mp4", width: 1080, height: 1920, bitrate: 1, quality: "source" } }));
      }
      if (url.endsWith("/api/exports/exp_1")) {
        return new Response(JSON.stringify({ export: { waiting: { reason: "memory", message: "Waiting for memory — 1 export running" } } }));
      }
      const result = { filePath: "/s/p/exports/P.mp4", sizeBytes: 1, durationSeconds: 1, backend: "ffmpeg-overlay", width: 1080, height: 1920 };
      return new Response(
        `event: progress\ndata: ${JSON.stringify({ jobId: "job-1", done: 0, total: 1, unit: "waiting" })}\n\n` +
          `event: completed\ndata: ${JSON.stringify({ jobId: "job-1", result })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const sendNotification = vi.fn(async () => {});
    const r = await exportVideo({ pieceId: "p" }, { _meta: { progressToken: "t" }, sendNotification } as never);
    expect(r.success).toBe(true);
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ message: "Waiting for memory — 1 export running" }) }),
    );
  });
});

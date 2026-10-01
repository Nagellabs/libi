import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/libi-home", async (orig) => ({ ...(await orig<typeof import("@/lib/libi-home")>()), getCurrentPort: () => 3461 }));
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { exportVideo } from "@/mcp/tools/export-tools";
import { DEST_FOLDER_REFUSAL } from "@/lib/exports/types";

beforeEach(() => fetchMock.mockReset());

describe("libi.export_video — exports live in the piece", () => {
  it("refuses a destFolder before asking the studio anything", async () => {
    const r = await exportVideo({ pieceId: "p1", destFolder: "/Users/me/Desktop" });
    expect(r).toEqual({ success: false, data: { error: "dest_folder_removed", hint: DEST_FOLDER_REFUSAL } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the export's id with its file", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jobId: "job-1", exportId: "exp_1", name: "Promo", chromiumDownloadMb: null, settings: { format: "mp4", width: 1080, height: 1920, bitrate: 1, quality: "source" } }), { status: 200 }),
    );
    const result = { filePath: "/s/p1/exports/Promo.mp4", sizeBytes: 1, durationSeconds: 1, backend: "ffmpeg-overlay", width: 1080, height: 1920 };
    fetchMock.mockResolvedValueOnce(
      new Response(`event: completed\ndata: ${JSON.stringify({ jobId: "job-1", result })}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    const r = await exportVideo({ pieceId: "p1" });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ filePath: "/s/p1/exports/Promo.mp4", jobId: "job-1", exportId: "exp_1" });
  });
});

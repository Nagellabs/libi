import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/libi-home", async (orig) => ({ ...(await orig<typeof import("@/lib/libi-home")>()), getCurrentPort: () => 3461 }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/mcp/notify", () => ({ notify: { navigate } }));
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { listExports } from "@/mcp/tools/export-list-tool";

const view = (over: Record<string, unknown>) => ({
  id: "exp_1", pieceId: "p1", pieceName: "Piece", jobId: "job-1", name: "Promo", fileName: "Promo.mp4",
  path: "/s/p1/exports/Promo.mp4", status: "done", missing: false, error: null, queuedAt: Date.UTC(2026, 8, 29, 10),
  startedAt: null, completedAt: Date.UTC(2026, 8, 29, 10, 1), sizeBytes: 2048, durationSec: 15, width: 1080, height: 1920,
  aspect: "9:16", container: "mp4", codec: "avc", fps: 30, quality: "source", graphicsQuality: "4k", purpose: "social",
  carriesCopyrighted: false, excludedFileIds: [], backend: "ffmpeg-overlay", droppedOverlays: null, source: "agent",
  progress: null, waiting: null, ...over,
});
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  fetchMock.mockReset();
  navigate.mockReset();
});

describe("libi.list_exports", () => {
  it("reads the piece's export records and answers them in the agent's shape", async () => {
    fetchMock.mockResolvedValueOnce(
      answer({
        exports: [
          view({}),
          view({ id: "exp_2", name: "Wide", status: "running", path: null, completedAt: null, progress: { done: 40, total: 100, unit: "%", etaMs: 5000 } }),
          view({ id: "exp_3", name: "Tall", status: "queued", path: null, completedAt: null, waiting: { reason: "memory", message: "Waiting for memory — 2 exports running" } }),
        ],
      }),
    );
    const r = await listExports({ pieceId: "p1" });
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:3461/api/pieces/p1/exports");
    expect(r.success).toBe(true);
    const rows = (r.data as { exports: Array<Record<string, unknown>> }).exports;
    expect(rows[0]).toEqual({
      exportId: "exp_1", name: "Promo", status: "done", path: "/s/p1/exports/Promo.mp4", missing: false, format: "mp4",
      width: 1080, height: 1920, aspect: "9:16", sizeBytes: 2048, durationSeconds: 15,
      queuedAt: "2026-09-29T10:00:00.000Z", completedAt: "2026-09-29T10:01:00.000Z", carriesCopyrightedMusic: false,
      percent: null, waiting: null, error: null, startedBy: "agent",
    });
    expect(rows[1]).toMatchObject({ exportId: "exp_2", percent: 40 });
    expect(rows[2]).toMatchObject({ exportId: "exp_3", waiting: "Waiting for memory — 2 exports running" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("filters by status, and opens the Exports tab when asked", async () => {
    fetchMock.mockResolvedValueOnce(answer({ exports: [view({}), view({ id: "exp_2", status: "failed", error: "boom" })] }));
    const r = await listExports({ pieceId: "p1", status: "failed", show: true });
    expect((r.data as { exports: unknown[] }).exports).toHaveLength(1);
    expect(navigate).toHaveBeenCalledWith({ target: "exports", pieceId: "p1" });
  });

  it("an unknown piece is a structured error", async () => {
    fetchMock.mockResolvedValueOnce(answer({ error: "Piece not found" }, 404));
    expect(await listExports({ pieceId: "nope" })).toMatchObject({ success: false, error: "piece_not_found" });
  });
});

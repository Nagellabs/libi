import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/libi-home", async (orig) => ({ ...(await orig<typeof import("@/lib/libi-home")>()), getCurrentPort: () => 3461 }));
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { exportVideoVariants, VARIANTS_NOTE } from "@/mcp/tools/export-tools";
import { DEST_FOLDER_REFUSAL } from "@/lib/exports/types";

const enq = (n: number, width: number, height: number, format = "mp4") =>
  new Response(JSON.stringify({ jobId: `job-${n}`, exportId: `exp_${n}`, name: `Piece${n === 1 ? "" : `-${n - 1}`}`, chromiumDownloadMb: null, settings: { format, width, height, bitrate: 1, quality: "custom" } }));

beforeEach(() => fetchMock.mockReset());

describe("libi.export_video with variants", () => {
  it("queues every variant in one call and returns at once with what was queued", async () => {
    fetchMock.mockResolvedValueOnce(enq(1, 1080, 1920)).mockResolvedValueOnce(enq(2, 1920, 1080));
    const r = await exportVideoVariants({
      pieceId: "p1",
      purpose: "social",
      variants: [{ quality: "source" }, { quality: "custom", customWidth: 1920, customHeight: 1080, filename: "Wide" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies[0]).toMatchObject({ pieceId: "p1", purpose: "social", quality: "source", batchSize: 2 });
    expect(bodies[1]).toMatchObject({ pieceId: "p1", purpose: "social", quality: "custom", customWidth: 1920, customHeight: 1080, filename: "Wide", batchSize: 2 });
    // No wait on any job's event stream.
    expect(fetchMock.mock.calls.every((c) => String(c[0]).endsWith("/api/export"))).toBe(true);
    expect(r).toEqual({
      success: true,
      data: {
        queued: [
          { exportId: "exp_1", name: "Piece", format: "mp4", width: 1080, height: 1920 },
          { exportId: "exp_2", name: "Piece-1", format: "mp4", width: 1920, height: 1080 },
        ],
        note: VARIANTS_NOTE,
      },
    });
  });

  it("a variant's own audio choice wins over the shared one", async () => {
    fetchMock.mockResolvedValueOnce(enq(1, 1080, 1920)).mockResolvedValueOnce(enq(2, 1080, 1920));
    await exportVideoVariants({ pieceId: "p1", purpose: "social", variants: [{ copyrightedAudio: "include" }, { copyrightedAudio: "exclude" }] });
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies.map((b) => b.copyrightedAudio)).toEqual(["include", "exclude"]);
  });

  it("a refusal stops the batch and says what WAS queued", async () => {
    fetchMock
      .mockResolvedValueOnce(enq(1, 1080, 1920))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "custom quality requires customWidth and customHeight" }), { status: 400 }));
    const r = await exportVideoVariants({ pieceId: "p1", variants: [{}, { quality: "custom" }] });
    expect(r).toEqual({
      success: false,
      data: {
        error: "export_enqueue_failed_400",
        hint: "custom quality requires customWidth and customHeight",
        queued: [{ exportId: "exp_1", name: "Piece", format: "mp4", width: 1080, height: 1920 }],
        note: "1 of 2 exports were queued and are still rendering — retry only the remaining variants (from index 1), not the whole call.",
        failedIndex: 1,
      },
    });
  });

  it("a network failure part-way carries the same note and index", async () => {
    fetchMock.mockResolvedValueOnce(enq(1, 1080, 1920)).mockResolvedValueOnce(enq(2, 1080, 1920)).mockRejectedValueOnce(new Error("socket hang up"));
    const r = await exportVideoVariants({ pieceId: "p1", variants: [{}, {}, {}] });
    expect(r).toMatchObject({
      success: false,
      data: {
        error: "export_enqueue_failed",
        hint: "socket hang up",
        failedIndex: 2,
        note: "2 of 3 exports were queued and are still rendering — retry only the remaining variants (from index 2), not the whole call.",
      },
    });
  });

  it("a refusal of the FIRST variant queued nothing, so it carries no partial-batch note", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "nope" }), { status: 400 }));
    const r = await exportVideoVariants({ pieceId: "p1", variants: [{}, {}] });
    expect(r).toEqual({ success: false, data: { error: "export_enqueue_failed_400", hint: "nope", queued: [] } });
  });

  it("destFolder is refused here too", async () => {
    const r = await exportVideoVariants({ pieceId: "p1", destFolder: "/x", variants: [{}] });
    expect(r).toEqual({ success: false, data: { error: "dest_folder_removed", hint: DEST_FOLDER_REFUSAL, queued: [] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so when a variant was fitted for social (no size named), and only then", async () => {
    const fitted = new Response(JSON.stringify({ jobId: "job-1", exportId: "exp_1", name: "Piece", chromiumDownloadMb: null, settings: { format: "mp4", width: 1080, height: 1920, bitrate: 1, quality: "source", socialFit: true } }));
    fetchMock.mockResolvedValueOnce(fitted).mockResolvedValueOnce(enq(2, 3840, 2160));
    const r = await exportVideoVariants({ pieceId: "p1", purpose: "social", variants: [{}, { quality: "4k" }] });
    const note = (r.data as { note: string }).note;
    expect(note).toContain(VARIANTS_NOTE);
    expect(note).toContain("One was fitted for social");
    fetchMock.mockResolvedValueOnce(enq(3, 3840, 2160));
    const plain = await exportVideoVariants({ pieceId: "p1", variants: [{ quality: "4k" }] });
    expect((plain.data as { note: string }).note).toBe(VARIANTS_NOTE);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useExportFlow } from "@/hooks/editor/use-export-flow";

/**
 * `useExportFlow` POSTs to `/api/export` and hands back the queued export —
 * nothing more. Progress and the finish live on the export's record (the
 * Exports tab, the canvas bar, the finish toast): a second Start is never
 * blocked by the first (spec 2026-09-29 §B2).
 */
const START = { pieceId: "p1", source: "draft" as const, filename: "X", format: "mp4" as const, quality: "source" as const };
let fetchMock: ReturnType<typeof vi.fn>;
/** The export POSTs (the analytics beacon also goes through fetch). */
const enqueues = () => fetchMock.mock.calls.filter(([url]) => url === "/api/export");

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobId: "job-1", exportId: "exp_1", name: "X" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("useExportFlow", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useExportFlow());
    expect(result.current.status).toBe("idle");
    expect(result.current.queued).toBeNull();
  });

  it("start() sends the settings and lands on queued with the export's id and name", async () => {
    const { result } = renderHook(() => useExportFlow());
    let returned: unknown;
    await act(async () => {
      returned = await result.current.start({ ...START, graphicsQuality: "1440p" });
    });
    // The queued export is handed back too, for a caller that acts on it at once.
    expect(returned).toEqual({ exportId: "exp_1", name: "X", pieceId: "p1" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ pieceId: "p1", graphicsQuality: "1440p" });
    expect(body.destFolder).toBeUndefined();
    expect(result.current.status).toBe("queued");
    expect(result.current.queued).toEqual({ exportId: "exp_1", name: "X", pieceId: "p1" });
  });

  it("never blocks a second Start: another export queues while the first is still rendering", async () => {
    const { result } = renderHook(() => useExportFlow());
    await act(() => result.current.start(START));
    await act(() => result.current.start({ ...START, filename: "Y" }));
    expect(enqueues()).toHaveLength(2);
  });

  it("ignores a double click on the same Start while it is still being sent", async () => {
    const { result } = renderHook(() => useExportFlow());
    await act(async () => {
      await Promise.all([result.current.start(START), result.current.start(START)]);
    });
    expect(enqueues()).toHaveLength(1);
  });

  it("a failed POST shows the route's words; reset() returns to idle", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "includeFileIds must be an array of strings" }), { status: 400 }));
    const { result } = renderHook(() => useExportFlow());
    let returned: unknown = "unset";
    await act(async () => {
      returned = await result.current.start(START);
    });
    expect(returned).toBeNull();
    expect(result.current.status).toBe("failed");
    expect(result.current.error).toBe("includeFileIds must be an array of strings");
    act(() => result.current.reset());
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("a 422 purpose_required is not an error: idle, purposeRequired set, the caller told to refetch", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "purpose_required", message: "This piece has copyrighted music (x)." }), { status: 422 }));
    const onPurposeRequired = vi.fn();
    const { result } = renderHook(() => useExportFlow({ onPurposeRequired }));
    await act(() => result.current.start(START));
    expect(result.current.status).toBe("idle");
    expect(result.current.purposeRequired).toBe(true);
    expect(onPurposeRequired).toHaveBeenCalledWith("p1");
  });
});

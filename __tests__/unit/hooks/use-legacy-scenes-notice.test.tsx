// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info, error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

import {
  useLegacyScenesNotice,
  legacyScenesNoticeText,
  resetLegacyScenesNoticeForTests,
} from "@/hooks/editor/use-legacy-scenes-notice";

/**
 * A piece opened with canvas-scene layers from libi 0.1.0/0.1.1 — which load
 * as nothing now — says so ONCE per piece. "Already told" is the SERVER's
 * answer (`legacyScenesNoticed` on GET …/composition), recorded by the POST the
 * hook sends after the toast: the packaged app's origin changes every launch,
 * so browser storage could not keep it. Nothing is read from or written to
 * localStorage.
 */
describe("useLegacyScenesNotice", () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true })));

  beforeEach(() => {
    info.mockClear();
    fetchMock.mockClear();
    resetLegacyScenesNoticeForTests();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("tells the user once and records it on the server", () => {
    const { rerender } = renderHook(({ id, n, told }) => useLegacyScenesNotice(id, n, told), {
      initialProps: { id: "p1" as string | null, n: 3 as number | undefined, told: false as boolean | undefined },
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe(legacyScenesNoticeText(3));
    expect(info.mock.calls[0][0]).toMatch(/3 canvas-scene layers from libi 0\.1\.0\/0\.1\.1/);
    expect(info.mock.calls[0][0]).toMatch(/no longer supported/);
    expect(info.mock.calls[0][0]).toMatch(/removed from the piece the next time it is saved/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/pieces/p1/composition/legacy-scenes-notice", { method: "POST" });

    // A refetch that hasn't seen the POST yet (still `false`) doesn't repeat it…
    rerender({ id: "p1", n: 3, told: false });
    // …and once the server says it was told, nothing either.
    rerender({ id: "p1", n: 3, told: true });
    expect(info).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The memory is not in the browser.
    expect(window.localStorage.length).toBe(0);
  });

  it("a later launch the server says was told stays quiet", () => {
    // A fresh page (new origin, empty storage), piece already told server-side.
    renderHook(() => useLegacyScenesNotice("p1", 3, true));
    expect(info).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("another piece gets its own notice", () => {
    renderHook(() => useLegacyScenesNotice("p1", 2, false));
    renderHook(() => useLegacyScenesNotice("p2", 1, false));
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1][0]).toMatch(/1 canvas-scene layer from/);
  });

  it("says nothing for no legacy scenes, an unknown count or flag, or no piece", () => {
    renderHook(() => useLegacyScenesNotice("p1", 0, false));
    renderHook(() => useLegacyScenesNotice("p1", undefined, false));
    renderHook(() => useLegacyScenesNotice("p1", 2, undefined));
    renderHook(() => useLegacyScenesNotice(null, 2, false));
    expect(info).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed record doesn't throw", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    renderHook(() => useLegacyScenesNotice("p3", 2, false));
    await Promise.resolve();
    expect(info).toHaveBeenCalledTimes(1);
  });
});

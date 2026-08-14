import { describe, it, expect, vi } from "vitest";
import { dispatchRefreshQueryData } from "@/lib/queries/dispatch-refresh-query";
import { trackKeys } from "@/lib/queries/tracks";

describe("dispatchRefreshQueryData track case", () => {
  it("invalidates trackKeys.detail(trackId) and returns true", () => {
    const invalidateQueries = vi.fn();
    const handled = dispatchRefreshQueryData(
      { queryKey: "track", trackId: "trk1" } as never,
      { invalidateQueries } as never,
    );
    expect(handled).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: trackKeys.detail("trk1") });
  });
  it("returns false when trackId is missing", () => {
    const invalidateQueries = vi.fn();
    expect(
      dispatchRefreshQueryData({ queryKey: "track" } as never, { invalidateQueries } as never),
    ).toBe(false);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

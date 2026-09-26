/**
 * `refresh_query { queryKey: "social" }` is emitted by every social write
 * route and by the agent-write hook. It must land as ONE invalidation of the
 * `["social"]` prefix — `pieceId` rides along as information only, because the
 * per-piece key (`["social","piece",<id>]`) is already under that prefix.
 */
import { describe, it, expect, vi } from "vitest";
import { dispatchRefreshQueryData } from "@/lib/queries/dispatch-refresh-query";
import { socialKeys } from "@/lib/queries/social";

describe("dispatchRefreshQueryData social case", () => {
  it("invalidates socialKeys.all and returns true", () => {
    const invalidateQueries = vi.fn();
    const handled = dispatchRefreshQueryData(
      { queryKey: "social" } as never,
      { invalidateQueries } as never,
    );
    expect(handled).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: socialKeys.all });
  });

  it("still invalidates exactly the prefix when a pieceId rides along", () => {
    const invalidateQueries = vi.fn();
    const handled = dispatchRefreshQueryData(
      { queryKey: "social", pieceId: "piece-1" } as never,
      { invalidateQueries } as never,
    );
    expect(handled).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["social"] });
  });

  it("leaves unrelated keys alone", () => {
    const invalidateQueries = vi.fn();
    expect(
      dispatchRefreshQueryData({ queryKey: "not-a-real-key" } as never, { invalidateQueries } as never),
    ).toBe(false);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

/** `refresh_query { queryKey: "exports" }` (every piece_exports write) → one invalidation of the exports prefix. */
import { describe, it, expect, vi } from "vitest";
import { dispatchRefreshQueryData } from "@/lib/queries/dispatch-refresh-query";
import { exportKeys } from "@/lib/queries/exports";

describe("dispatchRefreshQueryData exports case", () => {
  it("invalidates exportKeys.all whatever rides along", () => {
    const invalidateQueries = vi.fn();
    const handled = dispatchRefreshQueryData(
      { queryKey: "exports", pieceId: "p1", exportId: "exp_1", status: "done" } as never,
      { invalidateQueries } as never,
    );
    expect(handled).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: exportKeys.all });
  });

  it("the key factory nests every exports query under one prefix", () => {
    expect(exportKeys.forPiece("p1").slice(0, 1)).toEqual(exportKeys.all);
    expect(exportKeys.byId("e1").slice(0, 1)).toEqual(exportKeys.all);
    expect(exportKeys.active().slice(0, 1)).toEqual(exportKeys.all);
  });
});

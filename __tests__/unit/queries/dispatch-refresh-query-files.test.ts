import { describe, it, expect, vi } from "vitest";
import { dispatchRefreshQueryData } from "@/lib/queries/dispatch-refresh-query";
import { fileKeys } from "@/lib/queries/files";

describe("dispatchRefreshQueryData files case", () => {
  it("a fileId also refreshes that file's own details (the details panel reads it by id)", () => {
    const invalidateQueries = vi.fn();
    expect(dispatchRefreshQueryData({ queryKey: "files", pieceId: "p1", fileId: "f1" }, { invalidateQueries } as never)).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: fileKeys.byId("f1") });
  });
  it("without a fileId, no by-id refresh", () => {
    const invalidateQueries = vi.fn();
    dispatchRefreshQueryData({ queryKey: "files" }, { invalidateQueries } as never);
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: fileKeys.byId("f1") });
  });
});

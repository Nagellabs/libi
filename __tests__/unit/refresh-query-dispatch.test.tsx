import { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { dispatchRefreshQueryData } from "@/lib/queries/dispatch-refresh-query";
import { pieceKeys } from "@/lib/queries/pieces";
import { fileKeys } from "@/lib/queries/files";
import { effectsCatalogKeys } from "@/lib/queries/effects-catalog";
import { characterKeys, itemKeys } from "@/lib/queries/catalog";

describe("dispatchRefreshQueryData", () => {
  it("invalidates the custom-effects catalog for queryKey=effects-custom", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData({ queryKey: "effects-custom" }, qc);
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: effectsCatalogKeys.custom });
  });

  it("invalidates pieceKeys.all for queryKey=pieces", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData({ queryKey: "pieces" }, qc);
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: pieceKeys.all });
  });

  it("invalidates global + per-piece files for queryKey=files with pieceId", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData(
      { queryKey: "files", pieceId: "abc" },
      qc,
    );
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: fileKeys.global() });
    expect(spy).toHaveBeenCalledWith({ queryKey: fileKeys.forPiece("abc") });
  });

  it("invalidates only global files when pieceId absent", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData({ queryKey: "files" }, qc);
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: fileKeys.global() });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("invalidates piece detail, all, and forPiece in order for queryKey=piece", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData(
      { queryKey: "piece", pieceId: "pid-1" },
      qc,
    );
    expect(handled).toBe(true);
    expect(spy).toHaveBeenNthCalledWith(1, {
      queryKey: pieceKeys.detail("pid-1"),
    });
    expect(spy).toHaveBeenNthCalledWith(2, { queryKey: pieceKeys.all });
    expect(spy).toHaveBeenNthCalledWith(3, {
      queryKey: fileKeys.forPiece("pid-1"),
    });
  });

  it("returns false for piece event without pieceId", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData({ queryKey: "piece" }, qc);
    expect(handled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("invalidates analysis by fileId", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData(
      { queryKey: "analysis", fileId: "f1" },
      qc,
    );
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledWith({
      queryKey: ["analysis", "file", "f1"],
    });
  });

  it("returns false for analysis event without fileId", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData({ queryKey: "analysis" }, qc);
    expect(handled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns false for unknown queryKey (composition is handled by editor)", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData(
      { queryKey: "composition", pieceId: "x" },
      qc,
    );
    expect(handled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  type PredicateArg = { predicate?: (q: { queryKey: readonly unknown[] }) => boolean };
  const extractPredicate = (spy: { mock: { calls: unknown[][] } }) => {
    const call = spy.mock.calls.find((c) => "predicate" in ((c[0] ?? {}) as object));
    expect(call).toBeDefined();
    const predicate = (call![0] as unknown as PredicateArg).predicate;
    expect(predicate).toBeDefined();
    return predicate!;
  };

  it("invalidates the catalog + per-piece character queries for queryKey=characters", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData({ queryKey: "characters" }, qc);
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: characterKeys.all });
    const predicate = extractPredicate(spy);
    expect(predicate({ queryKey: characterKeys.forPiece("p1") })).toBe(true);
    expect(predicate({ queryKey: itemKeys.forPiece("p1") })).toBe(false);
  });

  it("invalidates the catalog + per-piece item queries for queryKey=items", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const handled = dispatchRefreshQueryData({ queryKey: "items" }, qc);
    expect(handled).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: itemKeys.all });
    const predicate = extractPredicate(spy);
    expect(predicate({ queryKey: itemKeys.forPiece("p1") })).toBe(true);
    expect(predicate({ queryKey: characterKeys.forPiece("p1") })).toBe(false);
  });
});

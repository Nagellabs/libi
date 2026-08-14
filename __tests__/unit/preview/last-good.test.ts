import { describe, it, expect } from "vitest";
import { compileWithFallback } from "@/lib/preview/last-good";

describe("compileWithFallback", () => {
  const compileOk = (s: string) => ({ tag: s });
  const compileThrow = () => {
    throw new Error("boom");
  };

  it("returns the new value on success and clears error", () => {
    const r = compileWithFallback("v2", compileOk, { value: { tag: "v1" }, error: null });
    expect(r).toEqual({ value: { tag: "v2" }, error: null });
  });
  it("keeps last-good and records error on failure", () => {
    const prev = { value: { tag: "v1" }, error: null };
    const r = compileWithFallback("bad", compileThrow as unknown as (s: string) => { tag: string }, prev);
    expect(r.value).toEqual({ tag: "v1" }); // last good retained
    expect(r.error).toMatch(/boom/);
  });
  it("error with no prior value yields null value + error", () => {
    const r = compileWithFallback(
      "bad",
      compileThrow as unknown as (s: string) => { tag: string },
      { value: null, error: null },
    );
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/boom/);
  });
});

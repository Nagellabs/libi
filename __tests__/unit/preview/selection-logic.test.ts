import { describe, it, expect } from "vitest";
import { resolveSelection } from "@/lib/preview/selection-logic";

describe("resolveSelection", () => {
  it("plain click replaces the selection with one id", () => {
    expect(resolveSelection("b", ["a"], {})).toEqual(["b"]);
  });
  it("meta/ctrl click toggles membership, preserving order", () => {
    expect(resolveSelection("b", ["a"], { meta: true })).toEqual(["a", "b"]);
    expect(resolveSelection("a", ["a", "b"], { meta: true })).toEqual(["b"]);
  });
  it("shift click adds without removing", () => {
    expect(resolveSelection("b", ["a"], { shift: true })).toEqual(["a", "b"]);
    expect(resolveSelection("a", ["a", "b"], { shift: true })).toEqual(["a", "b"]);
  });
  it("plain click on an already-only-selected id keeps it", () => {
    expect(resolveSelection("a", ["a"], {})).toEqual(["a"]);
  });
});

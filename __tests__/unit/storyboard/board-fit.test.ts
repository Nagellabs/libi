import { describe, it, expect } from "vitest";
import { newNodeIds, fitReadyIds, allMeasured } from "@/lib/storyboard/board-fit";

describe("newNodeIds", () => {
  it("returns the ids that were not known before, in next order", () => {
    expect(newNodeIds(new Set(["a", "b"]), ["a", "c", "b", "d"])).toEqual(["c", "d"]);
  });
  it("is empty when nothing was added (removals don't count)", () => {
    expect(newNodeIds(new Set(["a", "b", "c"]), ["a", "c"])).toEqual([]);
  });
  it("treats every id as new when nothing was known", () => {
    expect(newNodeIds(new Set(), ["a"])).toEqual(["a"]);
  });
});

describe("fitReadyIds", () => {
  const pending = new Set(["new"]);
  it("is true when a pending node reports its dimensions", () => {
    expect(fitReadyIds([{ type: "position", id: "old" }, { type: "dimensions", id: "new" }], pending)).toBe(true);
  });
  it("ignores dimension changes of nodes that were already on the board", () => {
    expect(fitReadyIds([{ type: "dimensions", id: "old" }], pending)).toBe(false);
  });
  it("ignores non-dimension changes of the pending node", () => {
    expect(fitReadyIds([{ type: "position", id: "new" }, { type: "select", id: "new" }], pending)).toBe(false);
  });
  it("is false with nothing pending, whatever the changes", () => {
    expect(fitReadyIds([{ type: "dimensions", id: "new" }], new Set())).toBe(false);
  });
  it("tolerates changes without an id (add)", () => {
    expect(fitReadyIds([{ type: "add" }], pending)).toBe(false);
  });
});

describe("allMeasured", () => {
  it("is true when every node has a positive measured box", () => {
    expect(allMeasured([{ measured: { width: 420, height: 480 } }, { measured: { width: 420, height: 300 } }])).toBe(true);
  });
  it("is false while any node is unmeasured or zero-sized", () => {
    expect(allMeasured([{ measured: { width: 420, height: 480 } }, {}])).toBe(false);
    expect(allMeasured([{ measured: { width: 0, height: 480 } }])).toBe(false);
    expect(allMeasured([{ measured: { width: 420 } }])).toBe(false);
  });
  it("is vacuously true for an empty board", () => {
    expect(allMeasured([])).toBe(true);
  });
});

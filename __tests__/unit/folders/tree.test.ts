import { describe, it, expect } from "vitest";
import { getAncestorIds, wouldCreateCycle, getDescendantIds } from "@/lib/folders/tree";
import type { FolderRecord } from "@/lib/db/schema/types";

function f(id: string, parent: string | null): FolderRecord {
  return {
    id,
    name: id,
    parentFolderId: parent,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as FolderRecord;
}

// a -> b -> c  (c child of b, b child of a);  d is separate root
const tree = [f("a", null), f("b", "a"), f("c", "b"), f("d", null)];

describe("folder tree helpers", () => {
  it("getAncestorIds walks parent chain", () => {
    expect(getAncestorIds("c", tree)).toEqual(["b", "a"]);
    expect(getAncestorIds("a", tree)).toEqual([]);
  });

  it("getDescendantIds collects the whole subtree", () => {
    expect(getDescendantIds("a", tree).sort()).toEqual(["b", "c"]);
    expect(getDescendantIds("c", tree)).toEqual([]);
  });

  it("wouldCreateCycle rejects self-parenting", () => {
    expect(wouldCreateCycle("a", "a", tree)).toBe(true);
  });

  it("wouldCreateCycle rejects moving into own descendant", () => {
    expect(wouldCreateCycle("a", "c", tree)).toBe(true);
  });

  it("wouldCreateCycle allows a valid move", () => {
    expect(wouldCreateCycle("d", "c", tree)).toBe(false);
    expect(wouldCreateCycle("c", null, tree)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { linkedAssetNames } from "@/lib/catalog/piece-links";

const groups = [
  { file: { id: "f1", name: "clip-a.mp4", type: "video" }, entities: [{ id: "c1", name: "Jess" }, { id: "c2", name: "Max" }] },
  { file: { id: "f2", name: "clip-b.mp4", type: "video" }, entities: [{ id: "c1", name: "Jess" }] },
  { file: { id: "f3", name: "photo.png", type: "image" }, entities: [{ id: "c2", name: "Max" }] },
];

describe("linkedAssetNames", () => {
  it("returns the file names an entity is linked to within the piece, de-duped and in order", () => {
    expect(linkedAssetNames(groups, "c1")).toEqual(["clip-a.mp4", "clip-b.mp4"]);
    expect(linkedAssetNames(groups, "c2")).toEqual(["clip-a.mp4", "photo.png"]);
  });
  it("returns [] for an entity not present in any group", () => {
    expect(linkedAssetNames(groups, "nope")).toEqual([]);
  });
});

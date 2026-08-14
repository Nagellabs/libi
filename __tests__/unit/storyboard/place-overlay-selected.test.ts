// __tests__/unit/storyboard/place-overlay-selected.test.ts
import { describe, it, expect } from "vitest";
import { selectedClipFileId } from "@/lib/storyboard/place-overlay";
import type { StoryboardCard } from "@/lib/storyboard/types";

const card = {
  id: "c", clips: [
    { id: "t1", fileId: "F1", label: "v1", createdAt: 0 },
    { id: "t2", fileId: "F2", label: "v2", createdAt: 1 },
  ], selectedClipId: "t2",
} as StoryboardCard;

describe("selectedClipFileId", () => {
  it("returns the selected take's file", () => {
    expect(selectedClipFileId(card)).toBe("F2");
  });
  it("falls back to legacy clipFileId", () => {
    expect(selectedClipFileId({ id: "c", clipFileId: "OLD" } as StoryboardCard)).toBe("OLD");
  });
  it("returns undefined with no clip", () => {
    expect(selectedClipFileId({ id: "c" } as StoryboardCard)).toBeUndefined();
  });
});

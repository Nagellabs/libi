import { describe, it, expect } from "vitest";
import { visibleTakes, selectedTake, isOnTimeline } from "@/lib/storyboard/take-view";
import type { StoryboardCard } from "@/lib/storyboard/types";

const card = {
  id: "c",
  clips: [
    { id: "t1", fileId: "F1", label: "v1", createdAt: 0 },
    { id: "t2", fileId: "F2", label: "v2", createdAt: 1, hidden: true },
    { id: "t3", fileId: "F3", label: "v3", createdAt: 2 },
  ],
  selectedClipId: "t3",
} as StoryboardCard;

describe("take-view", () => {
  it("visibleTakes excludes hidden", () => {
    expect(visibleTakes(card).map((t) => t.id)).toEqual(["t1", "t3"]);
  });
  it("selectedTake returns the selected visible take", () => {
    expect(selectedTake(card)?.id).toBe("t3");
  });
  it("selectedTake is undefined when the selected id is hidden or missing", () => {
    expect(selectedTake({ ...card, selectedClipId: "t2" } as StoryboardCard)).toBeUndefined();
    expect(selectedTake({ id: "x" } as StoryboardCard)).toBeUndefined();
  });
  it("isOnTimeline is true only when a selected visible take exists", () => {
    expect(isOnTimeline(card)).toBe(true);
    expect(isOnTimeline({ id: "x" } as StoryboardCard)).toBe(false);
  });
});

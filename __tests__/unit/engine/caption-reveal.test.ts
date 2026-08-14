import { describe, it, expect } from "vitest";
import { activeWordIndexByProgress, currentWordLabel } from "@/lib/engine/text-anim/caption-reveal";
describe("activeWordIndexByProgress", () => {
  const words = ["the", "quick", "brown", "fox"];
  it("maps progress to a word index", () => {
    expect(activeWordIndexByProgress(words, 0)).toBe(0);
    expect(activeWordIndexByProgress(words, 0.49)).toBe(1);
    expect(activeWordIndexByProgress(words, 0.99)).toBe(3);
  });
  it("clamps to last word at progress 1", () => { expect(activeWordIndexByProgress(words, 1)).toBe(3); });
  it("returns -1 for empty", () => { expect(activeWordIndexByProgress([], 0.5)).toBe(-1); });
});
describe("currentWordLabel", () => {
  it("returns only the active word for word-current reveal", () => {
    expect(currentWordLabel(["a", "b", "c"], 0.5)).toBe("b");
    expect(currentWordLabel([], 0.5)).toBe("");
  });
});

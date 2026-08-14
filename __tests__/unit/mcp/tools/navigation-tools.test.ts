import { describe, it, expect } from "vitest";
import {
  showPiece,
  showAsset,
  showPreview,
  showStoryboard,
} from "@/mcp/tools/navigation-tools";

describe("showPiece", () => {
  it("returns navigation success for a pieceId", async () => {
    const result = await showPiece({ pieceId: "abc" });
    expect(result).toEqual({
      success: true,
      data: { navigated: true, pieceId: "abc" },
    });
  });
});

describe("showAsset", () => {
  it("returns navigation success with pieceId and fileId", async () => {
    const result = await showAsset({ pieceId: "abc", fileId: "file-1" });
    expect(result).toEqual({
      success: true,
      data: { navigated: true, pieceId: "abc", fileId: "file-1" },
    });
  });
});

describe("showPreview", () => {
  it("returns navigation success for a pieceId", async () => {
    const result = await showPreview({ pieceId: "abc" });
    expect(result).toEqual({
      success: true,
      data: { navigated: true, pieceId: "abc" },
    });
  });
});

describe("showStoryboard", () => {
  it("returns navigation success for a pieceId", async () => {
    const result = await showStoryboard({ pieceId: "abc" });
    expect(result).toEqual({
      success: true,
      data: { navigated: true, pieceId: "abc" },
    });
  });
});

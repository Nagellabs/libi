import { describe, it, expect } from "vitest";
import { safeAnnotateColor } from "@/lib/tracking/annotate-frame";

describe("safeAnnotateColor", () => {
  it("passes through hex colors", () => {
    expect(safeAnnotateColor("#ff0000")).toBe("#ff0000");
    expect(safeAnnotateColor("#fff")).toBe("#fff");
    expect(safeAnnotateColor("#11223344")).toBe("#11223344");
  });

  it("lowercases and passes through plain alphabetic color names", () => {
    expect(safeAnnotateColor("red")).toBe("red");
    expect(safeAnnotateColor("Cyan")).toBe("cyan");
  });

  it("falls back to red for undefined / empty", () => {
    expect(safeAnnotateColor(undefined)).toBe("red");
    expect(safeAnnotateColor("")).toBe("red");
    expect(safeAnnotateColor("   ")).toBe("red");
  });

  it("rejects injection strings with ffmpeg filter metacharacters", () => {
    // Break-out attempt: extra filter appended via comma/colon/@.
    expect(safeAnnotateColor("red@1.0,crop=1:1:0:0")).toBe("red");
    expect(safeAnnotateColor("red:x=0")).toBe("red");
    expect(safeAnnotateColor("'; rm -rf /")).toBe("red");
    // rgb() carries commas which would be read as filterchain separators.
    expect(safeAnnotateColor("rgb(255, 0, 0)")).toBe("red");
    expect(safeAnnotateColor("#gggggg")).toBe("red");
  });
});

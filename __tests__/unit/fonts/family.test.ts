import { describe, it, expect } from "vitest";
import { cssFamilyForFontFile, withFamily, parseFontShorthand } from "@/lib/fonts/family";

describe("font family helpers", () => {
  it("derives a stable, CSS-safe family name from a fileId", () => {
    expect(cssFamilyForFontFile("abc-123")).toBe("libifont-abc-123");
    // deterministic
    expect(cssFamilyForFontFile("abc-123")).toBe(cssFamilyForFontFile("abc-123"));
  });

  it("parses a CSS font shorthand into size + family", () => {
    expect(parseFontShorthand("700 60px Inter, sans-serif")).toEqual({
      prefix: "700 60px",
      family: "Inter, sans-serif",
    });
    expect(parseFontShorthand("48px Inter")).toEqual({ prefix: "48px", family: "Inter" });
  });

  it("replaces only the family, preserving size/weight prefix", () => {
    expect(withFamily("700 60px Inter, sans-serif", "libifont-x")).toBe(
      "700 60px libifont-x, sans-serif",
    );
    expect(withFamily("48px Inter", "libifont-x")).toBe("48px libifont-x, sans-serif");
  });

  it("returns the original string when it cannot parse a size", () => {
    expect(withFamily("inherit", "libifont-x")).toBe("inherit");
  });
});

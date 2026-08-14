import { describe, it, expect } from "vitest";
import { KNOWN_PARAMS, catalogEntry, GROUP_ORDER, nearestAspectOption } from "@/lib/storyboard/param-catalog";

describe("param catalog", () => {
  it("maps well-known keys to label + group", () => {
    expect(catalogEntry("prompt")).toMatchObject({ group: "Prompting", label: "Prompt" });
    expect(catalogEntry("start_frame")).toMatchObject({ group: "Keyframing" });
    expect(catalogEntry("reference_video")).toMatchObject({ group: "References" });
    expect(catalogEntry("generate_audio")).toMatchObject({ group: "Audio" });
    expect(catalogEntry("duration")).toMatchObject({ group: "Parameters" });
  });
  it("returns undefined for unknown keys", () => {
    expect(catalogEntry("cfg_scale")).toBeUndefined();
  });
  it("GROUP_ORDER lists the five groups in display order", () => {
    expect(GROUP_ORDER).toEqual(["Prompting", "Keyframing", "References", "Audio", "Parameters"]);
  });
  it("every KNOWN_PARAMS entry has a group in GROUP_ORDER", () => {
    for (const e of Object.values(KNOWN_PARAMS)) expect(GROUP_ORDER).toContain(e.group);
  });
});

describe("nearestAspectOption", () => {
  it("picks 9:16 for a 1080x1920 portrait piece", () => {
    expect(nearestAspectOption(1080, 1920)).toBe("9:16");
  });

  it("picks 16:9 for a 1920x1080 landscape piece", () => {
    expect(nearestAspectOption(1920, 1080)).toBe("16:9");
  });

  it("picks 1:1 for a square piece", () => {
    expect(nearestAspectOption(1080, 1080)).toBe("1:1");
  });

  it("picks the CLOSEST option when the piece's exact ratio isn't in the catalog", () => {
    // 1280x800 = 1.6 ratio. Catalog ratios: 16:9≈1.778, 4:3≈1.333, 1:1=1,
    // 3:4=0.75, 9:16=0.5625, 21:9≈2.333. |1.6-1.778|=0.178 is the smallest
    // gap, so 16:9 wins over the numerically-simpler 4:3 (|1.6-1.333|=0.267).
    expect(nearestAspectOption(1280, 800)).toBe("16:9");
  });

  it("uses a caller-supplied options list instead of the catalog fallback", () => {
    // Only 1:1 and 21:9 offered — a 1080x1920 piece (0.5625) is closer to
    // neither of the catalog's usual portrait options, so it must pick from
    // what's actually offered rather than falling back to "9:16".
    expect(nearestAspectOption(1080, 1920, ["1:1", "21:9"])).toBe("1:1");
  });

  it("returns null for non-positive dimensions", () => {
    expect(nearestAspectOption(0, 1080)).toBeNull();
    expect(nearestAspectOption(1080, 0)).toBeNull();
    expect(nearestAspectOption(-100, 1080)).toBeNull();
  });

  it("returns null when no option is parseable", () => {
    expect(nearestAspectOption(1920, 1080, ["not-a-ratio", "also bad"])).toBeNull();
  });
});

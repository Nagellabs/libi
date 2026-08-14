import { describe, it, expect } from "vitest";
import {
  CAPTION_PRESETS,
  applyCaptionPreset,
  matchCaptionPreset,
  type CaptionPresetPatch,
} from "@/lib/overlays/caption-presets";
import { SAFE_FONTS } from "@/lib/overlays/caption-fonts";
import type { TextOverlay } from "@/lib/engine/types";

function makeOverlay(over: Partial<TextOverlay> | CaptionPresetPatch = {}): TextOverlay {
  return {
    id: "o1",
    kind: "text",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { x: 0, y: 0, width: 100, height: 50 },
    opacity: 1,
    content: "Hello",
    font: "48px Inter",
    color: "#888888",
    align: "left",
    ...over,
  } as TextOverlay;
}

describe("CAPTION_PRESETS", () => {
  it("includes the five expected ids", () => {
    const ids = CAPTION_PRESETS.map((p) => p.id);
    expect(ids).toEqual(["clean", "boxed", "outline", "pop", "typed"]);
  });

  it("each preset has a label and a partial", () => {
    for (const p of CAPTION_PRESETS) {
      expect(typeof p.label).toBe("string");
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.partial).toBeTypeOf("object");
    }
  });

  it("clean sets white color and a soft shadow", () => {
    const clean = CAPTION_PRESETS.find((p) => p.id === "clean")!.partial;
    expect(clean.color).toBe("#ffffff");
    expect(clean.shadow).toBeDefined();
  });

  it("boxed sets a background plate", () => {
    const boxed = CAPTION_PRESETS.find((p) => p.id === "boxed")!.partial;
    expect(boxed.color).toBe("#ffffff");
    expect(boxed.background).toBeDefined();
    expect(boxed.background!.color).toContain("rgba");
  });

  it("outline sets a black stroke of width 6", () => {
    const outline = CAPTION_PRESETS.find((p) => p.id === "outline")!.partial;
    expect(outline.stroke).toBeDefined();
    expect(outline.stroke!.width).toBe(6);
  });

  it("pop sets yellow color, a stroke, and a pop reveal", () => {
    const pop = CAPTION_PRESETS.find((p) => p.id === "pop")!.partial;
    expect(pop.color).toBe("#ffd400");
    expect(pop.stroke).toBeDefined();
    expect(pop.reveal).toBeDefined();
    expect(pop.reveal!.mode).toBe("pop");
  });

  it("typed sets a stroke and a typewriter reveal with fraction 0.6", () => {
    const typed = CAPTION_PRESETS.find((p) => p.id === "typed")!.partial;
    expect(typed.stroke).toBeDefined();
    expect(typed.reveal).toBeDefined();
    expect(typed.reveal!.mode).toBe("typewriter");
    expect(typed.reveal!.fraction).toBe(0.6);
  });
});

describe("applyCaptionPreset", () => {
  it("returns the preset partial for a known id", () => {
    expect(applyCaptionPreset("pop").reveal!.mode).toBe("pop");
    expect(applyCaptionPreset("boxed").background).toBeDefined();
  });

  it("returns {} for an unknown id", () => {
    expect(applyCaptionPreset("nope")).toEqual({});
    expect(applyCaptionPreset("")).toEqual({});
  });

  it("nulls the nullable style keys a preset omits (idempotent application)", () => {
    // pop sets color/stroke/reveal but not background/shadow — those must be
    // explicitly nulled so applying pop over a boxed overlay clears the plate.
    const pop = applyCaptionPreset("pop");
    expect(pop.background).toBeNull();
    expect(pop.shadow).toBeNull();
    expect(pop.stroke).toBeDefined();
    expect(pop.reveal).toBeDefined();
  });
});

describe("matchCaptionPreset", () => {
  it("returns the preset id for an overlay built from that preset", () => {
    for (const preset of CAPTION_PRESETS) {
      const overlay = makeOverlay(applyCaptionPreset(preset.id));
      expect(matchCaptionPreset(overlay)).toBe(preset.id);
    }
  });

  it("returns null for an unstyled overlay", () => {
    expect(matchCaptionPreset(makeOverlay())).toBeNull();
  });

  it("re-applying a different preset clears stale keys and re-marks active (idempotent)", () => {
    const boxed = makeOverlay(applyCaptionPreset("boxed"));
    expect(matchCaptionPreset(boxed)).toBe("boxed");
    // Switch to pop — the stale background plate from boxed must be cleared so
    // the pop chip reads as active (the QA-found defect).
    const switched = makeOverlay({ ...boxed, ...applyCaptionPreset("pop") });
    expect(matchCaptionPreset(switched)).toBe("pop");
  });

  it("returns null when the overlay has extra styling the preset omits", () => {
    // boxed sets color + background; add a stroke it does not declare.
    const overlay = makeOverlay({
      ...applyCaptionPreset("boxed"),
      stroke: { color: "#000000", width: 6 },
    });
    expect(matchCaptionPreset(overlay)).toBeNull();
  });
});

describe("SAFE_FONTS", () => {
  it("includes curated web-safe + bundled families", () => {
    expect(SAFE_FONTS).toContain("Inter");
    expect(SAFE_FONTS).toContain("Arial");
    expect(SAFE_FONTS).toContain("Times New Roman");
    expect(SAFE_FONTS).toContain("Impact");
  });

  it("has no duplicate entries", () => {
    expect(new Set(SAFE_FONTS).size).toBe(SAFE_FONTS.length);
  });
});

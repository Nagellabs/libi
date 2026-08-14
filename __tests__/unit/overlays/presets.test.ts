import { describe, it, expect } from "vitest";
import {
  extractPresetFields, applyPresetPatch, matchPreset, isValidPresetSlug,
  PRESET_EXCLUDED_KEYS, type OverlayPreset,
} from "@/lib/overlays/presets";

const textOverlay = {
  id: "o1", kind: "text", content: "Hi", rect: { x: 0, y: 0, width: 100, height: 40 },
  startTime: 0, duration: 2, z: 3, opacity: 0.9,
  font: "48px Inter", color: "#ffd400", align: "center",
  stroke: { color: "#000", width: 6 },
  reveal: { mode: "flythrough", direction: "rtl" },
  threeD: { depth: 20 },
  transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0.5, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  effects: { in: { effectId: "fade", durationMs: 400 } },
} satisfies Record<string, unknown> & { kind: string };

describe("extractPresetFields", () => {
  it("captures reusable style/animation/transform fields", () => {
    const f = extractPresetFields(textOverlay);
    expect(f.color).toBe("#ffd400");
    expect(f.stroke).toEqual({ color: "#000", width: 6 });
    expect(f.reveal).toEqual({ mode: "flythrough", direction: "rtl" });
    expect(f.threeD).toEqual({ depth: 20 });
    expect(f.transform3d).toBeDefined();
    expect(f.effects).toEqual({ in: { effectId: "fade", durationMs: 400 } });
    expect(f.opacity).toBe(0.9);
  });
  it("excludes per-instance keys", () => {
    const f = extractPresetFields(textOverlay);
    for (const k of PRESET_EXCLUDED_KEYS) expect(k in f).toBe(false);
    expect("content" in f).toBe(false);
    expect("rect" in f).toBe(false);
    expect("id" in f).toBe(false);
    expect("kind" in f).toBe(false);
    expect("z" in f).toBe(false);
  });
});

describe("applyPresetPatch", () => {
  it("returns the preset's fields as the merge patch", () => {
    const preset: OverlayPreset = { id: "p", name: "P", kind: "text", source: "user", fields: { color: "#fff", reveal: { mode: "pop" } } };
    expect(applyPresetPatch(preset)).toEqual({ color: "#fff", reveal: { mode: "pop" } });
  });
});

describe("matchPreset", () => {
  it("returns the id of the preset whose fields equal the overlay's captured subset", () => {
    const preset: OverlayPreset = { id: "gold", name: "Gold", kind: "text", source: "bundled",
      fields: { color: "#ffd400", stroke: { color: "#000", width: 6 }, reveal: { mode: "flythrough", direction: "rtl" }, threeD: { depth: 20 },
        transform3d: textOverlay.transform3d, effects: { in: { effectId: "fade", durationMs: 400 } }, opacity: 0.9 } };
    expect(matchPreset(textOverlay, [preset])).toBe("gold");
    expect(matchPreset({ ...textOverlay, color: "#000" }, [preset])).toBeNull();
  });
  it("ignores presets of a different kind", () => {
    const preset: OverlayPreset = { id: "img", name: "Img", kind: "image", source: "user", fields: { opacity: 0.9 } };
    expect(matchPreset(textOverlay, [preset])).toBeNull();
  });
  it("most-specific wins: a sparse preset never shadows a richer subset match", () => {
    // Both are subsets of a boxed-styled overlay; clean pins only color, boxed
    // pins color + background. boxed must win regardless of list order.
    const overlay = { id: "o", kind: "text", color: "#ffffff", background: { color: "rgba(0,0,0,0.6)" } };
    const clean: OverlayPreset = { id: "clean", name: "Clean", kind: "text", source: "bundled", fields: { color: "#ffffff" } };
    const boxed: OverlayPreset = { id: "boxed", name: "Boxed", kind: "text", source: "bundled", fields: { color: "#ffffff", background: { color: "rgba(0,0,0,0.6)" } } };
    expect(matchPreset(overlay, [clean, boxed])).toBe("boxed"); // clean listed first, boxed still wins
    expect(matchPreset(overlay, [boxed, clean])).toBe("boxed");
  });
  it("an empty-fields preset never matches", () => {
    const empty: OverlayPreset = { id: "empty", name: "Empty", kind: "text", source: "user", fields: {} };
    expect(matchPreset(textOverlay, [empty])).toBeNull();
    // even alongside a real match, the empty one is not returned
    const gold: OverlayPreset = { id: "gold", name: "Gold", kind: "text", source: "bundled", fields: { color: "#ffd400" } };
    expect(matchPreset(textOverlay, [empty, gold])).toBe("gold");
  });
});

describe("isValidPresetSlug", () => {
  it("accepts lowercase slugs, rejects traversal/uppercase/empty", () => {
    expect(isValidPresetSlug("my-gold-look")).toBe(true);
    expect(isValidPresetSlug("a")).toBe(true);
    expect(isValidPresetSlug("../etc")).toBe(false);
    expect(isValidPresetSlug("Foo")).toBe(false);
    expect(isValidPresetSlug("")).toBe(false);
    expect(isValidPresetSlug("has.dot")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  CAPTION_STYLES,
  STYLE_NULLABLE_KEYS,
  styleToFields,
  captionStyleToFields,
} from "@/lib/captions/styles";
import type { CaptionStyle } from "@/lib/captions/types";
import { activeWordIndex, KARAOKE_LEAD_S } from "@/lib/engine/text-anim/caption-logic";

describe("CAPTION_STYLES (static looks only)", () => {
  it("has at least 6 curated static looks", () => {
    expect(CAPTION_STYLES.length).toBeGreaterThanOrEqual(6);
  });
  it("has unique ids", () => {
    const ids = CAPTION_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("has a non-empty label for every style", () => {
    for (const s of CAPTION_STYLES) {
      expect(typeof s.label).toBe("string");
      expect(s.label.length).toBeGreaterThan(0);
    }
  });
  it("every style declares source 'bundled' and a color", () => {
    for (const s of CAPTION_STYLES) {
      expect(s.source).toBe("bundled");
      expect(typeof s.color).toBe("string");
      expect(s.color.length).toBeGreaterThan(0);
    }
  });
  it("NO style carries a reveal/animation field — styles are static looks", () => {
    for (const s of CAPTION_STYLES) {
      expect((s as unknown as Record<string, unknown>).reveal).toBeUndefined();
    }
  });
  it("dropped the reveal-only looks (typed / karaoke / highlight-words / fade)", () => {
    const ids = new Set(CAPTION_STYLES.map((s) => s.id));
    for (const dropped of ["typed", "karaoke", "highlight-words", "fade"]) {
      expect(ids.has(dropped)).toBe(false);
    }
  });
});

describe("styleToFields", () => {
  it("applies the pop look (yellow color + stroke) and never writes reveal", () => {
    const f = styleToFields("pop") as Record<string, unknown>;
    expect(f.color).toBe("#ffd400");
    expect(f.stroke).toEqual({ color: "#000000", width: 6 });
    // A style is look-only — it must NOT carry a reveal (that stays in Effects).
    expect("reveal" in f).toBe(false);
  });

  it("nulls the nullable look keys pop omits (background, shadow) but keeps stroke", () => {
    const f = styleToFields("pop") as Record<string, unknown>;
    expect(f.background).toBeNull();
    expect(f.shadow).toBeNull();
    expect(f.stroke).not.toBeNull();
  });

  it("never emits a reveal key (applying a style preserves the chosen effect)", () => {
    for (const s of CAPTION_STYLES) {
      const f = styleToFields(s.id) as Record<string, unknown>;
      expect("reveal" in f).toBe(false);
    }
  });

  it("emits null for every STYLE_NULLABLE_KEY the style omits", () => {
    // clean only sets shadow; the other nullable keys must be null
    const f = styleToFields("clean") as Record<string, unknown>;
    for (const key of STYLE_NULLABLE_KEYS) {
      if (key === "shadow") {
        expect(f[key]).not.toBeNull();
      } else {
        expect(f[key]).toBeNull();
      }
    }
  });

  it("returns {} for an unknown id", () => {
    expect(styleToFields("unknown-xyz")).toEqual({});
  });
});

describe("captionStyleToFields (object form — supports user styles)", () => {
  it("spreads the look fields and nulls omitted nullable keys", () => {
    const userStyle: CaptionStyle = {
      id: "my-glow",
      label: "My Glow",
      source: "user",
      color: "#ffee00",
      shadow: { color: "rgba(0,240,255,0.9)", blur: 18, dx: 0, dy: 0 },
      fontWeight: 700,
    };
    const f = captionStyleToFields(userStyle) as Record<string, unknown>;
    expect(f.color).toBe("#ffee00");
    expect(f.fontWeight).toBe(700);
    expect(f.shadow).toEqual({ color: "rgba(0,240,255,0.9)", blur: 18, dx: 0, dy: 0 });
    // omitted nullable keys are cleared so switching styles is idempotent
    expect(f.background).toBeNull();
    expect(f.stroke).toBeNull();
    // never writes reveal (look-only)
    expect("reveal" in f).toBe(false);
  });

  it("agrees with styleToFields for a bundled id", () => {
    const boxed = CAPTION_STYLES.find((s) => s.id === "boxed")!;
    expect(captionStyleToFields(boxed)).toEqual(styleToFields("boxed"));
  });
});

describe("karaoke lead (activeWordIndex reads ~80ms ahead)", () => {
  const WORDS = [
    { text: "Salon", start: 0.0 },
    { text: "nails", start: 0.46 },
    { text: "at", start: 0.74 },
    { text: "home", start: 1.28 },
  ];

  it("exposes an ~80ms lead constant", () => {
    expect(KARAOKE_LEAD_S).toBeCloseTo(0.08, 5);
  });

  it("highlights the next word slightly BEFORE its audio onset", () => {
    // 50ms before "nails" starts (0.46): the lead (80ms) pulls index forward to 1
    expect(activeWordIndex(WORDS, 0.46 - 0.05)).toBe(1);
    // Without the lead this would be index 0 — sanity-check a point further back
    // (more than a lead before the boundary) still resolves to the earlier word.
    expect(activeWordIndex(WORDS, 0.46 - 0.2)).toBe(0);
  });
});

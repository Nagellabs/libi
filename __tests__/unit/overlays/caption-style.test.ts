import { describe, it, expect } from "vitest";
import {
  composeFont,
  wrapText,
  typewriterCharCount,
  fadeWordsAlpha,
  slideUpOffset,
  popScale,
} from "@/lib/overlays/caption-style";

/** Fake measure: every char is 10px wide. */
const measure = (s: string) => s.length * 10;

describe("composeFont", () => {
  it("returns font unchanged when no structured fields are set", () => {
    expect(composeFont({ font: "48px Inter" })).toBe("48px Inter");
    expect(composeFont({ font: "bold 72px Georgia" })).toBe("bold 72px Georgia");
  });

  it("composes from explicit fields when any structured field is set", () => {
    expect(
      composeFont({ font: "48px Inter", fontFamily: "Roboto", fontSize: 60, fontWeight: 700 }),
    ).toBe("700 60px Roboto");
  });

  it("fills sane defaults for the unset structured fields", () => {
    // weight default 400 when only size set
    expect(composeFont({ font: "48px Inter", fontSize: 32 })).toBe("400 32px Inter");
    // family default "Inter" when only weight set and font has no family token
    expect(composeFont({ font: "48px", fontWeight: 600 })).toBe("600 48px Inter");
  });

  it("parses size and family from the existing font string as fallback", () => {
    // only fontWeight overridden — size 48 + family Georgia parsed from font
    expect(composeFont({ font: "48px Georgia", fontWeight: 900 })).toBe("900 48px Georgia");
    // only fontFamily overridden — weight 400 default, size 24 parsed
    expect(composeFont({ font: "24px Arial", fontFamily: "Oswald" })).toBe("400 24px Oswald");
  });

  it("defaults size to 48 when font has no parseable size", () => {
    expect(composeFont({ font: "Inter", fontWeight: 500 })).toBe("500 48px Inter");
  });
});

describe("wrapText", () => {
  it("greedily wraps words to fit maxWidth", () => {
    // each word 4 chars = 40px; with spaces. maxWidth 90 => 2 words per line (40+10+40=90)
    const lines = wrapText(measure, "aaaa bbbb cccc dddd", 90);
    expect(lines).toEqual(["aaaa bbbb", "cccc dddd"]);
  });

  it("respects explicit \\n as hard breaks", () => {
    const lines = wrapText(measure, "aa\nbb cc", 1000);
    expect(lines).toEqual(["aa", "bb cc"]);
  });

  it("wraps within each hard-break segment", () => {
    const lines = wrapText(measure, "aaaa bbbb\ncccc dddd", 90);
    expect(lines).toEqual(["aaaa bbbb", "cccc dddd"]);
  });

  it("places a single word longer than maxWidth on its own line (no empty leading line)", () => {
    const lines = wrapText(measure, "verylongword short", 50);
    expect(lines[0]).toBe("verylongword");
    expect(lines).not.toContain("");
    expect(lines[0]).not.toBe("");
  });

  it("never produces an empty leading line when the first word overflows", () => {
    const lines = wrapText(measure, "enormousword", 30);
    expect(lines).toEqual(["enormousword"]);
  });

  it("returns an empty array for empty text", () => {
    expect(wrapText(measure, "", 100)).toEqual([]);
    expect(wrapText(measure, "   ", 100)).toEqual([]);
  });
});

describe("typewriterCharCount", () => {
  it("is 0 at progress 0", () => {
    expect(typewriterCharCount(10, 0)).toBe(0);
  });

  it("reaches fullLen at progress >= fraction", () => {
    expect(typewriterCharCount(10, 0.6, 0.6)).toBe(10);
    expect(typewriterCharCount(10, 1, 0.6)).toBe(10);
  });

  it("defaults fraction to 0.6", () => {
    expect(typewriterCharCount(10, 0.6)).toBe(10);
    expect(typewriterCharCount(10, 0.3)).toBe(5);
  });

  it("is monotonic non-decreasing in progress", () => {
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const n = typewriterCharCount(20, p, 0.6);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it("never exceeds fullLen", () => {
    expect(typewriterCharCount(7, 2, 0.6)).toBe(7);
  });
});

describe("fadeWordsAlpha", () => {
  it("returns one alpha per word", () => {
    expect(fadeWordsAlpha(4, 0.5)).toHaveLength(4);
  });

  it("is all ~0 at progress 0", () => {
    const a = fadeWordsAlpha(5, 0);
    for (const v of a) expect(v).toBeCloseTo(0, 5);
  });

  it("is all 1 at progress 1", () => {
    const a = fadeWordsAlpha(5, 1);
    for (const v of a) expect(v).toBe(1);
  });

  it("staggers per word (earlier words lead)", () => {
    const a = fadeWordsAlpha(4, 0.4);
    expect(a[0]).toBeGreaterThanOrEqual(a[1]);
    expect(a[1]).toBeGreaterThanOrEqual(a[2]);
    expect(a[2]).toBeGreaterThanOrEqual(a[3]);
  });

  it("alphas stay within [0,1]", () => {
    for (const v of fadeWordsAlpha(6, 0.55)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("handles zero words", () => {
    expect(fadeWordsAlpha(0, 0.5)).toEqual([]);
  });
});

describe("slideUpOffset", () => {
  it("is 0 by progress 1 for every line", () => {
    for (let i = 0; i < 3; i++) {
      expect(slideUpOffset(i, 3, 1, 80)).toBeCloseTo(0, 5);
    }
  });

  it("decreases to 0 as progress increases (per line)", () => {
    const a = slideUpOffset(1, 3, 0.2, 80);
    const b = slideUpOffset(1, 3, 0.6, 80);
    const c = slideUpOffset(1, 3, 1, 80);
    expect(a).toBeGreaterThanOrEqual(b);
    expect(b).toBeGreaterThanOrEqual(c);
    expect(c).toBeCloseTo(0, 5);
  });

  it("staggers by line (later lines lag at the same progress)", () => {
    const first = slideUpOffset(0, 3, 0.3, 80);
    const last = slideUpOffset(2, 3, 0.3, 80);
    expect(last).toBeGreaterThanOrEqual(first);
  });
});

describe("popScale", () => {
  it("settles to exactly 1 at progress 1", () => {
    expect(popScale(1)).toBeCloseTo(1, 5);
  });

  it("overshoots above 1 before settling", () => {
    let sawOvershoot = false;
    for (let p = 0.5; p < 1; p += 0.02) {
      if (popScale(p) > 1.0001) sawOvershoot = true;
    }
    expect(sawOvershoot).toBe(true);
  });

  it("starts small at progress 0", () => {
    expect(popScale(0)).toBeLessThan(0.2);
  });
});

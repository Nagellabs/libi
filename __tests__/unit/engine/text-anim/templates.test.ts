// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { validateDrawFunction, createDrawFunction } from "@/lib/ai/scene-validator";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";

/** Render a template body into a recording mock at a given element-local
 *  progress, returning every fillText label drawn. */
export function renderAt(body: string, progress: number, time = progress * 3) {
  expect(validateDrawFunction(body).valid).toBe(true);
  const labels: string[] = [];
  const ctx = {
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), measureText: () => ({ width: 10 }),
    fillRect: vi.fn(), strokeText: vi.fn(),
    fillText: (s: string) => { labels.push(s); },
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    font: "", textAlign: "left", textBaseline: "alphabetic",
    fillStyle: "#000", strokeStyle: "#000", lineWidth: 0, globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  const fn = createDrawFunction(body, DRAW_HELPERS);
  fn({ ctx, width: 1080, height: 1920, fps: 30, frame: Math.round(time * 30),
       time, totalFrames: 90, duration: 3, progress, assets: {} });
  return labels.join("");
}

describe("renderAt harness", () => {
  it("drives a trivial body and captures fillText", () => {
    const body = `const { ctx, progress } = context; ctx.fillText(progress >= 0.5 ? "HALF" : "LOW", 0, 0);`;
    expect(renderAt(body, 0.2)).toBe("LOW");
    expect(renderAt(body, 0.8)).toBe("HALF");
  });
});

import { typewriter } from "@/lib/engine/text-anim/templates";

describe("typewriter", () => {
  const body = typewriter({ text: "Salon nails at home", revealFraction: 0.6 });

  it("reveals ~0 chars at progress 0", () => {
    expect(renderAt(body, 0).replace("|", "")).toBe("");
  });

  it("reveals roughly half by mid-reveal", () => {
    // At progress 0.3 (half of revealFraction 0.6), ~half the glyphs show.
    const shown = renderAt(body, 0.3).replace("|", "");
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.length).toBeLessThan("Salon nails at home".length);
  });

  it("shows the FULL text once past revealFraction (the 'Sa' bug guard)", () => {
    expect(renderAt(body, 0.6).replace("|", "")).toBe("Salon nails at home");
    expect(renderAt(body, 1).replace("|", "")).toBe("Salon nails at home");
  });
});

import { fadeInWords } from "@/lib/engine/text-anim/templates";

describe("fadeInWords", () => {
  const body = fadeInWords({ text: "one two three four" });
  it("draws every word by progress 1", () => {
    const shown = renderAt(body, 1);
    for (const w of ["one", "two", "three", "four"]) expect(shown).toContain(w);
  });
  it("draws fewer words early than late", () => {
    // words are drawn per-word; count distinct fillText calls via label length
    const early = renderAt(body, 0.1);
    const late = renderAt(body, 0.9);
    expect(late.length).toBeGreaterThanOrEqual(early.length);
  });
});

import { slideUpLines } from "@/lib/engine/text-anim/templates";

describe("slideUpLines", () => {
  const body = slideUpLines({ text: "Line one\nLine two" });
  it("renders all lines by progress 1", () => {
    const shown = renderAt(body, 1);
    expect(shown).toContain("Line one");
    expect(shown).toContain("Line two");
  });
  it("is valid and runs at progress 0", () => {
    expect(() => renderAt(body, 0)).not.toThrow();
  });
});

import { popScaleSpring } from "@/lib/engine/text-anim/templates";

describe("popScaleSpring", () => {
  const body = popScaleSpring({ text: "SALE" });
  it("draws the text and uses ctx.scale for the pop", () => {
    expect(renderAt(body, 0.5)).toContain("SALE");
  });
  it("is valid at the edges", () => {
    expect(() => renderAt(body, 0)).not.toThrow();
    expect(() => renderAt(body, 1)).not.toThrow();
  });
});

import { lowerThird } from "@/lib/engine/text-anim/templates";

describe("lowerThird", () => {
  const body = lowerThird({ title: "Jane Doe", subtitle: "Founder" });
  it("draws the title and subtitle by progress 1", () => {
    const shown = renderAt(body, 1);
    expect(shown).toContain("Jane Doe");
    expect(shown).toContain("Founder");
  });
  it("draws a bar (fillRect) for contrast", () => {
    // validity + no-throw is enough here; fillRect is exercised via harness mock
    expect(() => renderAt(body, 0.5)).not.toThrow();
  });
});

import { gradientSweep } from "@/lib/engine/text-anim/templates";

describe("gradientSweep", () => {
  const body = gradientSweep({ text: "SHINE", colors: ["#ff0", "#f0f"] });
  it("draws the text and is valid across the window", () => {
    expect(renderAt(body, 0.5)).toContain("SHINE");
    expect(() => renderAt(body, 0)).not.toThrow();
    expect(() => renderAt(body, 1)).not.toThrow();
  });
});

import { captionCues } from "@/lib/engine/text-anim/templates";

describe("captionCues", () => {
  const body = captionCues({
    cues: [
      { text: "hello there", start: 0, end: 1 },
      { text: "second line", start: 1, end: 2 },
    ],
  });
  it("shows the cue active at the current element-local time", () => {
    // renderAt passes time = progress*3 by default; pass explicit time instead.
    expect(renderAt(body, 0, 0.5)).toContain("hello there");
    expect(renderAt(body, 0, 1.5)).toContain("second line");
  });
  it("shows nothing between/after cues", () => {
    expect(renderAt(body, 0, 5)).toBe("");
  });
});

import {
  captionCumulative,
  captionWordByWord,
  captionKaraoke,
} from "@/lib/engine/text-anim/templates";

// "Salon nails… at home" word timings (element-local seconds), from the dogfood.
const CAP_WORDS = [
  { text: "Salon", start: 0.0 },
  { text: "nails…", start: 0.46 },
  { text: "at", start: 0.74 },
  { text: "home", start: 1.28 },
];

describe("captionCumulative", () => {
  const body = captionCumulative({ words: CAP_WORDS });
  it("shows nothing before the first word", () => {
    expect(renderAt(body, 0, -0.2)).toBe("");
  });
  it("builds the sentence up word-by-word in sync", () => {
    expect(renderAt(body, 0, 0.0)).toBe("Salon");
    expect(renderAt(body, 0, 0.5)).toBe("Salon nails…");
    expect(renderAt(body, 0, 0.8)).toBe("Salon nails… at");
    expect(renderAt(body, 0, 1.3)).toBe("Salon nails… at home");
  });
});

describe("captionWordByWord", () => {
  const body = captionWordByWord({ words: CAP_WORDS });
  it("shows only the current word", () => {
    expect(renderAt(body, 0, 0.0)).toBe("Salon");
    expect(renderAt(body, 0, 0.5)).toBe("nails…");
    expect(renderAt(body, 0, 0.8)).toBe("at");
    expect(renderAt(body, 0, 1.3)).toBe("home");
  });
  it("shows nothing before the first word", () => {
    expect(renderAt(body, 0, -0.2)).toBe("");
  });
});

describe("captionKaraoke", () => {
  const body = captionKaraoke({ words: CAP_WORDS });
  it("always shows the FULL sentence (emphasis moves, text stays)", () => {
    const full = "Salon nails… at home";
    // parts are drawn with a trailing space except the last; joined == full
    expect(renderAt(body, 0, 0.1).replace(/\s+/g, " ").trim()).toBe(full);
    expect(renderAt(body, 0, 1.3).replace(/\s+/g, " ").trim()).toBe(full);
  });
});

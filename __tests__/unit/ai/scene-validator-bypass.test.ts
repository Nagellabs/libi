import { describe, it, expect } from "vitest";
import { validateDrawFunction } from "@/lib/ai/scene-validator";
import {
  typewriter,
  fadeInWords,
  slideUpLines,
  popScaleSpring,
  lowerThird,
  gradientSweep,
  captionCues,
  captionCumulative,
  captionWordByWord,
  captionKaraoke,
} from "@/lib/engine/text-anim/templates";

/**
 * Defense-in-depth denylist hardening (RC-C, Task 5 Part B). These tests pin
 * the known bypasses the original 15-pattern denylist missed, and guard the
 * legitimate vetted templates against false positives.
 */
describe("validateDrawFunction — hardened denylist (bypasses REJECTED)", () => {
  const rejected: { name: string; code: string; label: string }[] = [
    {
      name: "dot-form constructor-walk RCE",
      code: `[].constructor.constructor("return process")()`,
      label: "constructor property access",
    },
    {
      name: "bare constructor property access",
      code: `const c = x.constructor.constructor;`,
      label: "constructor property access",
    },
    {
      name: "window.location.href navigation",
      code: `window.location.href='x'`,
      label: "location access",
    },
    {
      name: "location.assign navigation",
      code: `location.assign('x')`,
      label: "location access",
    },
    {
      name: "computed string-literal access to fetch",
      code: `window['fetch']('x')`,
      label: "computed dangerous property access",
    },
    {
      name: "globalThis.process reference",
      code: `const p = globalThis.process;`,
      // globalThis matches first in array order, but process is also present —
      // either is a legitimate rejection; assert it's rejected.
      label: "",
    },
    {
      name: "self['process'] computed access",
      code: `const p = self['process'];`,
      label: "computed dangerous property access",
    },
    {
      name: "bare process reference",
      code: `const e = process.env;`,
      label: "process access",
    },
    {
      name: "bare globalThis reference",
      code: `const g = globalThis;`,
      label: "globalThis access",
    },
  ];

  for (const { name, code, label } of rejected) {
    it(`rejects ${name}`, () => {
      const result = validateDrawFunction(code);
      expect(result.valid).toBe(false);
      if (label) expect(result.error).toContain(label);
    });
  }
});

describe("validateDrawFunction — legitimate bodies still ACCEPTED", () => {
  it("accepts a plain fillRect/fillStyle body", () => {
    const code = `ctx.fillRect(0,0,w,h); ctx.fillStyle='#fff';`;
    expect(validateDrawFunction(code).valid).toBe(true);
  });

  it("accepts a body using interpolate / spring / Math.sin", () => {
    const code = `
      const a = interpolate(0, 100, context.progress);
      const s = spring(context.time, 0, 1);
      const y = Math.sin(context.time) * 10 + a + s;
      context.ctx.fillRect(0, y, 50, 50);
    `;
    expect(validateDrawFunction(code).valid).toBe(true);
  });

  it("accepts method chains and bracket-index access (WORDS[i])", () => {
    const code = `
      const WORDS = ['a','b'];
      for (let i = 0; i < WORDS.length; i++) {
        ctx.measureText(WORDS[i]).width;
      }
    `;
    expect(validateDrawFunction(code).valid).toBe(true);
  });

  const templateBodies: { name: string; body: string }[] = [
    { name: "typewriter", body: typewriter({ text: "Hello world" }) },
    { name: "fadeInWords", body: fadeInWords({ text: "Hello world" }) },
    { name: "slideUpLines", body: slideUpLines({ text: "Line one\nLine two" }) },
    { name: "popScaleSpring", body: popScaleSpring({ text: "Pop!" }) },
    {
      name: "lowerThird",
      body: lowerThird({ title: "Name", subtitle: "Role" }),
    },
    { name: "gradientSweep", body: gradientSweep({ text: "Shine" }) },
    {
      name: "captionCues",
      body: captionCues({
        cues: [{ text: "one", start: 0, end: 1 }],
        karaoke: true,
      }),
    },
    {
      name: "captionCumulative",
      body: captionCumulative({
        words: [
          { text: "hello", start: 0 },
          { text: "world", start: 0.5 },
        ],
      }),
    },
    {
      name: "captionWordByWord",
      body: captionWordByWord({
        words: [
          { text: "hello", start: 0 },
          { text: "world", start: 0.5 },
        ],
      }),
    },
    {
      name: "captionKaraoke",
      body: captionKaraoke({
        words: [
          { text: "hello", start: 0 },
          { text: "world", start: 0.5 },
        ],
      }),
    },
  ];

  for (const { name, body } of templateBodies) {
    it(`accepts the vetted "${name}" template body`, () => {
      const result = validateDrawFunction(body);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  }
});

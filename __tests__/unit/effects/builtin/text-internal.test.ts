import { describe, it, expect } from "vitest";
import { typewriterEffect, fadeWordsEffect, slideUpLinesEffect } from "@/lib/effects/builtin/text-internal";
import { findEffect } from "@/lib/effects/registry";

describe("text-internal effects", () => {
  for (const e of [typewriterEffect, fadeWordsEffect, slideUpLinesEffect]) {
    it(`${e.meta.id} is text-only, in-phase, textInternal, identity animate`, () => {
      expect(e.meta.textInternal).toBe(true);
      expect(e.meta.supports).toEqual(["text"]);
      expect(e.meta.phases).toEqual(["in"]);
      expect(e.animate(0.5, {})).toEqual({});
      expect(findEffect(e.meta.id)).toBeDefined();
    });
  }
});

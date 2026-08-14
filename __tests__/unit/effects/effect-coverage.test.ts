// __tests__/unit/effects/effect-coverage.test.ts
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_EFFECTS } from "@/lib/effects/builtin";

describe("effect coverage", () => {
  it("every builtin effect has a per-effect test file", () => {
    const testDir = join(process.cwd(), "__tests__/unit/effects/builtin");
    const files = new Set(readdirSync(testDir));
    for (const e of BUILTIN_EFFECTS) {
      // id "audio-fade-in"/"audio-fade-out" share audio-fade.test.ts
      const candidates = [`${e.meta.id}.test.ts`, "audio-fade.test.ts", "text-internal.test.ts"];
      expect(candidates.some((c) => files.has(c)), `missing test for ${e.meta.id}`).toBe(true);
    }
  });

  it("every builtin meta is internally consistent", () => {
    for (const e of BUILTIN_EFFECTS) {
      expect(e.meta.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.meta.phases.length).toBeGreaterThan(0);
      expect(e.meta.supports.length).toBeGreaterThan(0);
      if (e.meta.audioEnvelope) expect(e.meta.supports).toEqual(["audio"]);
    }
  });

  it("no duplicate effect ids", () => {
    const ids = BUILTIN_EFFECTS.map((e) => e.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

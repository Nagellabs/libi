import { describe, it, expect, afterEach } from "vitest";
import {
  listEffects,
  findEffect,
  registerCustomEffects,
  clearCustomEffects,
} from "@/lib/effects/registry";

afterEach(() => clearCustomEffects());

describe("registry custom-effect merge", () => {
  it("merges custom effects and shadows built-ins by id", () => {
    registerCustomEffects([
      {
        meta: { id: "fade", name: "Custom Fade", family: "animation", phases: ["in"], supports: ["text"], params: [] },
        animate: () => ({ opacity: 1 }),
      },
    ]);
    expect(findEffect("fade")?.meta.name).toBe("Custom Fade"); // user shadows built-in
    registerCustomEffects([
      {
        meta: { id: "brand-new", name: "New", family: "animation", phases: ["loop"], supports: ["scene"], params: [] },
        animate: () => ({}),
      },
    ]);
    expect(listEffects({ kind: "scene" }).some((e) => e.meta.id === "brand-new")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { warnThreeFunction } from "@/lib/ai/scene-validator";
import { roadCaption } from "@/lib/engine/three-templates";

describe("warnThreeFunction (soft resource budget)", () => {
  it("returns null for a vetted template body", () => {
    expect(warnThreeFunction(roadCaption({ text: "HI" }))).toBeNull();
  });

  it("warns on a very high geometry segment count", () => {
    const w = warnThreeFunction("const g = new THREE.SphereGeometry(1, 2000, 2000); scene.add(new THREE.Mesh(g));");
    expect(w).toBeTruthy();
    expect(String(w).toLowerCase()).toContain("segment");
  });

  it("warns on a large mesh-building loop", () => {
    const w = warnThreeFunction("for (let i = 0; i < 50000; i++) { scene.add(new THREE.Mesh(geo, mat)); }");
    expect(w).toBeTruthy();
  });

  it("does NOT warn on a normal small loop with no geometry", () => {
    expect(warnThreeFunction("for (let i = 0; i < 10; i++) { total += i; } return ({ progress }) => {};")).toBeNull();
  });
});

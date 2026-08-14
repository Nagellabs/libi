import { describe, it, expect } from "vitest";
import { expansionSig } from "@/lib/engine/overlay-renderer";

const T = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
const RECT = { x: 0, y: 0, width: 100, height: 100 };

describe("expansionSig includes scale", () => {
  it("differs when only scale changes", () => {
    expect(expansionSig(T, RECT, 1)).not.toBe(expansionSig(T, RECT, 2));
  });
  it("is stable for identical inputs", () => {
    expect(expansionSig(T, RECT, 1.5)).toBe(expansionSig(T, RECT, 1.5));
  });
});

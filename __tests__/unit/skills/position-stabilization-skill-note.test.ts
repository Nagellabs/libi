import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const md = readFileSync("mcp/skills/using-object-tracking/SKILL.md", "utf8");

describe("skill: position stabilization guidance", () => {
  it("teaches positionMode as the bounce lever and the raw opt-out", () => {
    expect(/positionMode/.test(md)).toBe(true);
    expect(/positionMode:"raw"/.test(md)).toBe(true);
    expect(/POSITION-jitter problem|position.jitter/i.test(md)).toBe(true);
  });

  it("never claims interpolation removes jitter (the doomed catmull-rom advice)", () => {
    expect(/`catmull-rom` if jittery/.test(md)).toBe(false);
    expect(/NOT a denoiser/i.test(md)).toBe(true);
    // Smoothing example must not recommend catmull-rom as the attach default.
    expect(/smoothing: "catmull-rom"/.test(md)).toBe(false);
  });
});

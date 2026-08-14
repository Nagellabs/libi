import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const md = readFileSync("mcp/skills/using-object-tracking/SKILL.md", "utf8");

describe("skill: size stabilization guidance", () => {
  it("teaches size-vs-position and the update_tracked_overlay remedy", () => {
    expect(/balloon|flash/i.test(md)).toBe(true);
    expect(/size_jitter/.test(md)).toBe(true);
    expect(/sizeMode|maxBoxScale/.test(md)).toBe(true);
    expect(/update_tracked_overlay/.test(md)).toBe(true);
    expect(
      /SIZE problem.*not.*position|not a position problem/i.test(md),
    ).toBe(true);
  });
});

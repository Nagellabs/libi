import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const md = readFileSync(
  path.resolve(__dirname, "../../../mcp/skills/using-object-tracking/SKILL.md"),
  "utf8",
);

describe("using-object-tracking SKILL.md — visual verify", () => {
  it("step 5 uses libi.verify_tracked_overlay as the verification mechanism", () => {
    expect(md).toContain("libi.verify_tracked_overlay");
    expect(md).toMatch(/LOOK at the returned frames|look at the rendered frames/i);
  });
  it("states the verify loop is mandatory after compute and before attach", () => {
    expect(md).toMatch(/mandatory|must verify|do NOT attach/i);
  });
  it("frames anchored compute_track_segment as a first-class force-track move and notes it writes no ManualAnchor", () => {
    expect(md).toMatch(/force[- ]track/i);
    expect(md).toMatch(/no .*ManualAnchor|not a user manual anchor|transparent/i);
  });
});

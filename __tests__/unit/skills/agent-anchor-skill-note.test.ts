import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const md = readFileSync(
  path.resolve(__dirname, "../../../mcp/skills/using-object-tracking/SKILL.md"),
  "utf8",
);

describe("using-object-tracking SKILL.md — agent anchor persistence note", () => {
  it("states agent compute_track_segment anchors persist + are honored + re-seed", () => {
    expect(md).toMatch(/compute_track_segment/);
    expect(md).toMatch(/persist|re-seed|honored/i);
    expect(md).toMatch(/dense/i);
    expect(md).toMatch(/transparent|not user-visible|manual.*outrank/i);
  });
});

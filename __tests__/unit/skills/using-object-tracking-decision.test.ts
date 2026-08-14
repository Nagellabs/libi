// __tests__/unit/skills/using-object-tracking-decision.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const md = readFileSync(
  resolve(process.cwd(), "mcp/skills/using-object-tracking/SKILL.md"),
  "utf8",
);

describe("using-object-tracking SKILL — skip-vs-re-anchor decision", () => {
  it("teaches BOTH branches unambiguously", () => {
    expect(md).toContain("Skip-vs-re-anchor decision");
    // switch ⇒ re-anchor, NEVER skip
    expect(md).toMatch(/identity_switch_suspected[\s\S]{0,400}re-anchor/i);
    expect(md).toMatch(/NEVER\s+`?skip_segment`?[\s\S]{0,160}wrong-subject/i);
    // genuinely gone ⇒ skip, do not pile anchors onto an empty window
    expect(md).toMatch(/genuinely (absent|gone|occluded)[\s\S]{0,200}skip_segment/i);
    expect(md).toMatch(/cannot conjure a subject that isn'?t/i);
  });
});

// __tests__/unit/skills/using-object-tracking-generalized.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const md = readFileSync(
  resolve(process.cwd(), "mcp/skills/using-object-tracking/SKILL.md"),
  "utf8",
);

describe("using-object-tracking SKILL — generalized detector", () => {
  it("teaches automatic non-person routing + unchanged identity loop", () => {
    expect(md).toContain("Generalized detector");
    expect(md).toMatch(/non-person[\s\S]{0,300}automatic/i);
    expect(md).toMatch(/libi-tracking install plan[\s\S]{0,200}verify_install/i);
    expect(md).toMatch(/identity[\s\S]{0,160}(anchor|repair loop|B\+C)/i);
  });
});

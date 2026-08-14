import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("libi-tracking install plan", () => {
  it("exists and documents uv sync + verify_install + the dep", () => {
    const p = join(process.cwd(), "mcp/bundled-mcps/plans/libi-tracking.md");
    expect(existsSync(p)).toBe(true);
    const md = readFileSync(p, "utf8");
    expect(md).toMatch(/uv sync|tracking-pyenv/);
    expect(md).toMatch(/verify_install/);
  });
});

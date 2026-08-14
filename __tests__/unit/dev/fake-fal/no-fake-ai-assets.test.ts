import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("fake-ai-assets removed", () => {
  it("the old fake-ai-assets directory no longer exists", () => {
    expect(existsSync(join(process.cwd(), "mcp", "dev", "fake-ai-assets"))).toBe(false);
  });
});

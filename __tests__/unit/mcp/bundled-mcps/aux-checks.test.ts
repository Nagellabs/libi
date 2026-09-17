import { describe, it, expect } from "vitest";
import { checkBinary } from "@/mcp/bundled-mcps/aux-checks";

describe("checkBinary", () => {
  it("returns ok=true with path + version when binary exists and runs fast", async () => {
    const result = await checkBinary("echo");
    expect(result.name).toBe("echo");
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/^\/|^\w/); // a path
  });

  it("returns ok=false when binary not found", async () => {
    const result = await checkBinary("definitely-not-a-real-binary-9876");
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain("not found");
  });
});

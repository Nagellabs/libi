import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { buildFakeFalEntry } from "@/lib/mcp-config";

describe("buildFakeFalEntry", () => {
  it("returns a stdio entry pointing at the fake-fal in-repo entry", () => {
    const entry = buildFakeFalEntry();
    expect("command" in entry).toBe(true);
    const stdio = entry as { command: string; args?: string[] };
    expect(stdio.args?.some((a) => a.includes(join("mcp", "dev", "fake-fal", "index.ts")))).toBe(true);
  });
});

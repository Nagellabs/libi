/**
 * Pins the Remove-vs-Delete semantic into the tool descriptions agents
 * see at session start. If someone "cleans up" the wording and drops the
 * distinction, this catches it.
 */
import { describe, it, expect } from "vitest";

describe("MCP tool descriptions enforce Remove-vs-Delete", () => {
  it("audio_remove_clip description says file is NOT deleted", async () => {
    // Parse the server.ts source to pull the description string — avoids
    // spinning up the whole MCP server just for a string assertion.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("mcp/server.ts", "utf-8");
    const match = src.match(/"libi\.audio_remove_clip"[\s\S]*?description:\s*"([^"]+)"/);
    expect(match).toBeTruthy();
    expect(match![1]).toMatch(/NOT deleted/i);
    expect(match![1]).toMatch(/stays in resources/i);
  });

  it("delete_scene description says source file stays", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("mcp/server.ts", "utf-8");
    const match = src.match(/"libi\.delete_scene"[\s\S]*?description:\s*"([^"]+)"/);
    expect(match).toBeTruthy();
    expect(match![1]).toMatch(/NOT deleted/i);
  });
});
